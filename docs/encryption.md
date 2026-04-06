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

## Usage

Trovec provides a single, uniform API for encryption: `withEncryption()`. It works with **every** storage driver — built-in or custom.

```typescript
import { createFileDriver, createConcurrentFileDriver, withEncryption } from '@trovec/core';

// File driver
const driver = withEncryption(createFileDriver(), { key: myKey });

// Concurrent driver with WAL — same API, encryption covers WAL entries too
const walDriver = withEncryption(
  createConcurrentFileDriver({ directory: './data', wal: true }),
  { key: myKey },
);

// Custom / community drivers — encryption is handled transparently
const s3Driver = withEncryption(myCustomS3Driver, { key: myKey });
```

### How It Works Under the Hood

Built-in drivers (file, concurrent file) implement an optional `configureEncryption()` hook. When present, `withEncryption()` delegates to the driver itself — this ensures correct **compress-then-encrypt** ordering and native WAL encryption support. The original driver is returned as-is, preserving its full interface (WAL-awareness, `destroy()`, etc.).

For community / custom drivers that don't implement this hook, `withEncryption()` returns a thin wrapper that encrypts on `write()` and decrypts on `read()`. Custom drivers get encryption for free without implementing it themselves.

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

### Which Should I Use?

| Scenario | Recommended | Why |
|---|---|---|
| Server/production app with a secrets manager (Vault, AWS KMS, env vars) | `key` | You already have secure key storage — skip the PBKDF2 cost |
| CLI tool or local app where a user types a passphrase | `password` | Humans can remember passphrases; raw 32-byte keys are impractical to type |
| High-throughput writes (many flushes/appends) | `key` | Avoids PBKDF2 derivation overhead on every operation |
| Quick prototyping / dev environment | `password` | Just pass a string — no key generation step needed |

**Rule of thumb:** if a human provides the secret, use `password`. If a machine manages it, use `key`.

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
base write:  serialize -> compress -> encrypt (v2 envelope: DEK encrypts data, KEK wraps DEK) -> write to disk
base read:   read from disk -> unwrap DEK with KEK -> decrypt data with DEK -> decompress -> deserialize
WAL append:  serialize entry -> encrypt with DEK (v1 format) -> append to file
WAL read:    read encrypted entry -> decrypt with DEK -> validate CRC -> parse
```

Compression happens **before** encryption. This is intentional — encrypted data is incompressible (it looks like random bytes). By compressing the plaintext first, Trovec achieves optimal compression ratios.

WAL entries are encrypted with the DEK (Data Encryption Key) using v1 direct format rather than the full v2 envelope. This avoids per-entry KEK overhead — the DEK is learned from the base file on the first read or write and cached for the session.

### Encrypted Buffer Format

Trovec uses **v2 envelope encryption** for all new writes. A random DEK (Data Encryption Key) encrypts the data, and the user's KEK (Key Encryption Key) wraps the DEK. This two-layer design enables O(1) key rotation — only the 110-byte header needs rewriting when changing keys.

#### v2 Envelope Format (current default, 110-byte header)

```
[0]       format version: 2
[1]       key mode: 0 = raw key, 1 = password-derived (for KEK)
[2..5]    KEK version ID: uint32 LE (identifies which KEK encrypted this file)
[6..21]   salt: 16 bytes (zeros if raw key mode, random for password mode)
[22..33]  KEK-IV: 12 bytes (random, used to encrypt the DEK)
[34..49]  KEK-auth-tag: 16 bytes (GCM auth tag for DEK encryption)
[50..81]  encrypted DEK: 32 bytes (the data key, wrapped by the KEK)
[82..93]  data-IV: 12 bytes (random, used to encrypt the data)
[94..109] data-auth-tag: 16 bytes (GCM auth tag for data encryption)
[110..N]  ciphertext
```

- **KEK version ID** — allows operators to identify which KEK version encrypted a file without attempting decryption. Useful for tracking key rotation across a fleet.
- **Encrypted DEK** — the random per-file data key, wrapped with the KEK. During key rotation (`rekeyBuffer`), only this section and the KEK metadata are rewritten — the data ciphertext remains untouched.
- **AAD (Additional Authenticated Data)** — the format version, key mode, and KEK version ID are included as AAD when encrypting the DEK, preventing header field tampering.

#### v1 Direct Format (legacy, 46-byte header)

Files written before v2 use the v1 format. Trovec reads v1 files transparently — no migration is required for read compatibility. WAL entries also use v1 format internally (encrypted with the DEK rather than the KEK).

```
[0]       format version: 1
[1]       key mode: 0 = raw key, 1 = password-derived
[2..17]   salt: 16 bytes (zeros if raw key mode)
[18..29]  IV: 12 bytes (randomly generated per write)
[30..45]  auth tag: 16 bytes (GCM authentication tag)
[46..N]   ciphertext
```

To explicitly upgrade v1 files to v2 envelope format, use `trovec migrate --upgrade-format` or pass `upgradeFormat: true` to `migrateCollection()`.

### Encrypted WAL Format

When using the concurrent driver with encryption, the WAL file uses a framed format. Each entry is encrypted with the **DEK** using v1 direct format (not the full v2 envelope), avoiding per-entry KEK overhead:

```
[0..3]   encrypted header length (uint32 LE)
[4..N]   encrypted(WAL header: magic + version + dimensions + quantization)  — v1 format, DEK as key

Per entry:
  [0..3]  encrypted entry length (uint32 LE)
  [4..N]  encrypted(original entry: payload + CRC32)  — v1 format, DEK as key
```

The 4-byte length prefix for each entry is unencrypted — it's needed for framing (knowing where each entry ends). This only reveals entry sizes, not content.

The DEK is learned lazily from the base file on the first read or write and cached for the duration of the session. If no base file exists yet (first write to a new collection), one is created to establish the DEK before WAL appends can begin.

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

- **110 bytes per base file** (v2 envelope header) — negligible for collection files (megabytes)
- **46 bytes per WAL entry** (v1 header with DEK) — bounded by at most `checkpoint_threshold x 46` bytes before compaction

### CPU Overhead

Benchmarks with 128-dimension F32 vectors, raw key mode, concurrent file driver:

| Entries | Flush (plain) | Flush (encrypted) | Read (plain) | Read (encrypted) | File size |
|---|---|---|---|---|---|
| 1K | 21ms | 15ms | 21ms | 16ms | 950KB |
| 5K | 52ms | 52ms | 75ms | 65ms | 4.7MB |
| 10K | 113ms | 125ms | 118ms | 125ms | 9.5MB |
| 50K | 493ms | 623ms | 687ms | 809ms | 47.5MB |
| 100K | 987ms | 1291ms | 1459ms | 1592ms | 95MB |

At small sizes, encryption overhead is within noise. At 100K entries (the practical comfort zone), flush adds ~30% and read adds ~9%. File sizes are identical — the 110-byte v2 header is negligible.

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
| `kekVersionId` | `number` | `0` | KEK version identifier stored in the v2 header (uint32, 0–4294967295). Useful for tracking which key version encrypted a file. |
| `previousKeys` | `Array<{ key?, password?, iterations? }>` | — | Previous KEKs to try when the primary key fails to unwrap the DEK. Enables rolling key rotation: old files can still be read while new writes use the current KEK. Keys are tried in order. |

Works with any `StorageDriver`. For built-in drivers, encryption is handled internally (compress-then-encrypt, WAL support). For custom drivers, a transparent encrypt/decrypt wrapper is applied.

### Key Rotation

v2 envelope encryption supports two key rotation strategies:

**Fast rekey (O(1), header-only):** Use `rekeyBuffer()` or `trovec migrate --fast-rekey` to re-wrap the DEK with a new KEK without re-encrypting data. Only the 110-byte header is rewritten regardless of data size.

**Rolling rotation (zero-downtime):** Configure `previousKeys` so the system can read files encrypted with any previous KEK while writing new files with the current KEK. Deploy the new key, then migrate files at your own pace.

```typescript
const driver = withEncryption(createConcurrentFileDriver({ wal: true }), {
  key: newKey,
  kekVersionId: 2,
  previousKeys: [{ key: oldKey }],
});
```

## When to Use

| Scenario | Recommended Approach |
|---|---|
| Single-process app with sensitive data | `withEncryption(createFileDriver(), { key })` |
| Multi-process with sensitive data | `withEncryption(createConcurrentFileDriver({ wal: true }), { key })` |
| Testing or non-sensitive data | No encryption needed |
| Custom storage driver (S3, Redis, etc.) | `withEncryption(myCustomDriver, { key })` |
