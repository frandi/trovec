# Encryption at Rest

## The Problem: Sensitive Data on Disk

When Trovec persists vector embeddings to disk, the `.trovec` files are stored as compressed binary data — but they are **not encrypted**. Anyone with read access to the filesystem can extract the stored data, including:

- **Embedding vectors** — which can be [partially inverted](https://arxiv.org/abs/2310.06816) to recover approximate original text content
- **Entry IDs** — which may contain identifying information (usernames, document paths, etc.)
- **Context metadata** — which often contains the raw content that was vectorized

For applications handling medical records, legal documents, financial data, or any PII, this is a significant security gap. Trovec's encryption feature addresses this with **AES-256-GCM encryption at rest** — an opt-in layer that encrypts all data before it touches disk.

## Quick Start

```typescript
import { create, createFileDriver, withEncryption } from '@trovec/core';
import { randomBytes } from 'node:crypto';

// Generate a 256-bit key (store this securely!)
const key = randomBytes(32);

// Wrap any storage driver with encryption
const driver = withEncryption(createFileDriver({ directory: './data' }), { key });

const db = await create({
  dimensions: 384,
  storageDriver: driver,
  collectionId: 'sensitive-docs',
});

db.add({ id: 'patient-001', embedding: [...], context: { diagnosis: 'confidential' } });
await db.close();

// The .trovec file on disk is fully encrypted — no plaintext data or headers
```

## Two Integration Points

Trovec provides encryption through two complementary approaches, depending on whether you need WAL (Write-Ahead Log) support.

### 1. `withEncryption()` Wrapper (any driver, no WAL)

A composable wrapper that encrypts the entire buffer on `write()` and decrypts on `read()`. Works with **any** `StorageDriver` — file, memory, or custom.

```typescript
import { createFileDriver, withEncryption } from '@trovec/core';

const driver = withEncryption(createFileDriver(), {
  key: Buffer.from('0123456789abcdef0123456789abcdef'), // 32 bytes
});
```

The wrapper **does not propagate WAL-awareness**. When wrapping a concurrent file driver, the resulting driver is a plain `StorageDriver` — `core.ts` always takes the full serialize+write path. The inner driver's file locking still works; only WAL delta writes are bypassed.

### 2. Concurrent Driver with Built-in Encryption (WAL + encryption)

When you need both WAL and encryption, pass the `encryption` option directly to the concurrent driver. This encrypts both the base collection file (whole-file) and individual WAL entries (per-entry).

```typescript
import { createConcurrentFileDriver } from '@trovec/core';

const driver = createConcurrentFileDriver({
  directory: './data',
  wal: true,
  encryption: { key: myKey },
});
```

### Why Two Approaches?

The concurrent driver's `appendWal()` serializes `WalOperation` objects into binary format internally and appends them to the WAL file. A wrapper sitting outside the driver cannot intercept individual WAL entry bytes — `WalOperation` is a structured type, not a buffer. To encrypt WAL entries, the encryption transforms must be passed directly into the WAL serialization functions.

| Feature | `withEncryption()` | Concurrent driver `encryption` |
|---|---|---|
| Base file encryption | Yes | Yes |
| WAL entry encryption | No (WAL disabled) | Yes |
| Works with any driver | Yes | Only concurrent driver |
| File locking | Depends on inner driver | Yes |
| Composable | Yes | Built-in |

## Key Management

Trovec supports two key modes:

### Raw Key (recommended for production)

Provide a 32-byte (256-bit) key directly. You manage key storage — environment variables, a secrets manager, or an HSM.

```typescript
const driver = withEncryption(createFileDriver(), {
  key: Buffer.from(process.env.TROVEC_ENCRYPTION_KEY!, 'hex'),
});
```

### Password-Based Key Derivation

Derive a key from a password using PBKDF2-SHA256. The salt is generated randomly per write and stored in the encrypted file header — no external salt storage needed.

```typescript
const driver = withEncryption(createFileDriver(), {
  password: 'my-secret-passphrase',
  iterations: 100_000, // default: 100,000
});
```

Password mode is convenient but slower: key derivation adds ~100-200ms per read/write operation (at 100K iterations). A single-entry cache avoids re-derivation on consecutive reads of the same collection.

> **Important:** If you lose the key or password, the data is **unrecoverable**. Trovec does not store keys or provide key recovery.

## How It Works

### Data Flow

Without encryption:
```
write: serialize -> compress -> write to disk
read:  read from disk -> decompress -> deserialize
```

With encryption:
```
write: serialize -> compress -> encrypt -> write to disk
read:  read from disk -> decrypt -> decompress -> deserialize
```

With encryption + WAL:
```
base write:  serialize -> compress -> encrypt -> write to disk
base read:   read from disk -> decrypt -> decompress -> deserialize
WAL append:  serialize entry -> encrypt entry -> append to file
WAL read:    read encrypted entry -> decrypt -> validate CRC -> parse
```

Compression happens **before** encryption. This is intentional — encrypted data is incompressible (it looks like random bytes). By compressing the plaintext first, Trovec achieves optimal compression ratios.

### Encrypted Buffer Format

Every encrypted unit (file or WAL entry) uses the same 46-byte header:

```
[0]       format version: 1
[1]       key mode: 0 = raw key, 1 = password-derived
[2..17]   salt: 16 bytes (zeros if raw key mode)
[18..29]  IV: 12 bytes (randomly generated per write)
[30..45]  auth tag: 16 bytes (GCM authentication tag)
[46..N]   ciphertext
```

- **Format version** — enables future algorithm changes without breaking existing data
- **Key mode** — tells the decryptor whether to expect a salt for key derivation
- **Salt** — unique per write, used for PBKDF2 key derivation (zeros in raw key mode)
- **IV (Initialization Vector)** — 12 random bytes per write, ensuring identical plaintext produces different ciphertext
- **Auth tag** — GCM's 16-byte authentication tag, detecting both corruption and tampering
- **Ciphertext** — the encrypted data

### Encrypted WAL Format

When using the concurrent driver with encryption, the WAL file uses a framed format:

```
[0..3]   encrypted header length (uint32 LE)
[4..N]   encrypted(WAL header: magic + version + dimensions + quantization)

Per entry:
  [0..3]  encrypted entry length (uint32 LE)
  [4..N]  encrypted(original entry: payload + CRC32)
```

The 4-byte length prefix for each entry is unencrypted — it's needed for framing (knowing where each entry ends). This only reveals entry sizes, not content.

## What Gets Encrypted

| Data | Encrypted? |
|---|---|
| Embedding vectors | Yes |
| Entry IDs | Yes |
| Context metadata | Yes |
| Collection header (magic, version, dimensions, quantization, metric) | Yes |
| WAL header (magic, version, dimensions, quantization) | Yes (with concurrent driver) |
| WAL entries (operations, vectors, metadata) | Yes (with concurrent driver) |
| Lock files | No (coordination metadata only: PID, hostname, timestamp) |
| File names on disk | No (`collectionId.trovec` is visible) |

## Threat Model

Assuming an attacker has obtained the encrypted `.trovec` and `.trovec.wal` files:

### What the attacker CAN see

- **File existence and path** — they know a collection named `{collectionId}` exists
- **Total file size** — can estimate rough collection size
- **WAL entry count and sizes** — length prefixes are unencrypted, revealing how many operations occurred and whether they're puts (larger) or deletes (smaller)
- **Write timing** — if they have ongoing access, they can observe when files change

### What the attacker CANNOT do

- Read any vector data, IDs, or metadata
- Determine which specific records were modified
- Tamper with data undetected (GCM auth tag catches it)
- Decrypt without the key
- Run similarity searches on stolen vectors

### Why Vectors Must Be Encrypted

Embedding vectors are not one-way hashes. Research has demonstrated that text embeddings can be **partially inverted** — an attacker with the raw vectors can train inversion models that recover the semantic gist or even near-exact original text. Higher-dimensional embeddings (768d, 1536d) carry more recoverable signal.

Additionally, an attacker with raw vectors can run their own similarity searches. If they have any known reference vectors, they can find which records are semantically similar without accessing the original content.

This is why Trovec encrypts the **entire file** (vectors, IDs, and metadata together) rather than just the metadata.

## Performance Impact

AES-256-GCM is hardware-accelerated on modern CPUs (AES-NI instruction set). The encryption overhead is minimal compared to compression and disk I/O.

### Storage Overhead

- **46 bytes per encrypted unit** — negligible for collection files (megabytes) and bounded for WAL (at most `checkpoint_threshold x 46` bytes before compaction)

### CPU Overhead

Benchmarks with 128-dimension F32 vectors, raw key mode, concurrent file driver:

| Entries | Flush (plain) | Flush (encrypted) | Read (plain) | Read (encrypted) | File size |
|---|---|---|---|---|---|
| 1K | 21ms | 15ms | 21ms | 16ms | 950KB |
| 5K | 52ms | 52ms | 75ms | 65ms | 4.7MB |
| 10K | 113ms | 125ms | 118ms | 125ms | 9.5MB |
| 50K | 493ms | 623ms | 687ms | 809ms | 47.5MB |
| 100K | 987ms | 1291ms | 1459ms | 1592ms | 95MB |

At small sizes, encryption overhead is within noise. At 100K entries (the practical comfort zone), flush adds ~30% and read adds ~9%. File sizes are identical — the 46-byte header is negligible.

**WAL append throughput** (500 appends, 128d): plain 2422 ops/sec → encrypted 2140 ops/sec (+13% latency). Per-entry encryption cost is constant (~0.06ms) regardless of collection size.

**Large vectors** (768d, 1536d): encryption overhead becomes proportionally smaller as compression and I/O dominate.

- **Password mode:** PBKDF2 key derivation adds ~50-60ms per operation at 100K iterations. At 1K iterations the overhead is negligible; at 100K iterations a 5K-entry flush goes from ~38ms to ~94ms. Mitigated by internal key caching for repeated reads.

## Configuration Reference

### `withEncryption(driver, options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `key` | `Buffer` | — | Raw 32-byte encryption key (mutually exclusive with `password`) |
| `password` | `string` | — | Password for PBKDF2 key derivation (mutually exclusive with `key`) |
| `iterations` | `number` | `100_000` | PBKDF2 iteration count (only with `password`) |

### `createConcurrentFileDriver({ encryption })`

Accepts the same `EncryptionOptions` as `withEncryption`. When set, both the base collection file and WAL entries are encrypted.

```typescript
const driver = createConcurrentFileDriver({
  directory: './data',
  wal: true,
  encryption: {
    key: myKey,        // or password: 'my-passphrase'
  },
});
```

## When to Use Which

| Scenario | Recommended Approach |
|---|---|
| Single-process app with sensitive data | `withEncryption(createFileDriver(), { key })` |
| Multi-process with sensitive data | `createConcurrentFileDriver({ encryption: { key }, wal: true })` |
| Testing or non-sensitive data | No encryption needed |
| Custom storage driver (S3, Redis, etc.) | `withEncryption(myCustomDriver, { key })` |
