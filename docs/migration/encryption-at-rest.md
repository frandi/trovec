# Migrating to encryption at rest

This guide walks through enabling AES-256-GCM encryption on an **existing**
Trovec collection that was created before you started using encryption. Use it
when you're upgrading a `v2.1.0` deployment to `v2.2.0+` and want to turn
encryption on without rebuilding the collection from source.

## When you need this

`v2.2.0` introduced opt-in encryption at rest via `withEncryption`. Simply
wrapping your existing driver with `withEncryption` on an already-populated
plaintext directory **does not work** — on startup, the core tries to decrypt
the existing `.trovec` base file, finds the plaintext `VCR\x01` magic where it
expected an encryption header, and throws:

```
EncryptionError: Source buffer appears to be an unencrypted Trovec file.
  To enable encryption on an existing collection, migrate it first — ...
```

Enabling encryption is a **two-part change**, and both parts are required:

1. **Code change** — wrap your storage driver with `withEncryption(...)` so
   the app encrypts every new read and write. Without this, the code still
   treats the file as plaintext.
2. **Data migration** — copy the existing plaintext `.trovec` file to a new
   encrypted `.trovec` file. Without this, the app can't start: it will try
   to decrypt the plaintext file and fail.

This guide focuses on the **data migration** part. The code change is covered
in the main encryption doc — see [Encryption at Rest](../encryption.md) for
the full API, key management guidance, and performance notes.

`migrateCollection` (and the `trovec migrate` CLI on top of it) can also:

- **Decrypt** an encrypted collection back to plaintext (`--remove-encryption`) — useful for recovery or debugging.
- **Rotate** an existing encryption key to a new one (`--encryption-key` + `--new-key`).
- **Fast rekey** an existing v2 collection to a new key in O(1) time (`--fast-rekey`) — only the 110-byte header is rewritten, data ciphertext is untouched.
- **Upgrade format** from v1 direct encryption to v2 envelope encryption (`--upgrade-format`) — can use the same key, no key change required.
- **Rolling rotation** with previous keys (`--previous-key` / `--previous-password`) — read files encrypted with an old key while writing with the current one.

## Before you start

1. **Generate a key** and store it somewhere safe and out-of-band:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   The output is a 64-char hex string (32 raw bytes). **Losing this key means
   losing the data.** There is no recovery path.

2. **Stop every writer** attached to the collection. The migration tool reads
   from the source directory; a concurrent writer may leave the collection in a
   state the migration cannot safely snapshot. If a `.trovec.lock` file is
   present in the source when you run `trovec migrate`, the tool refuses to
   proceed.

3. **Back up** the source directory if you'd like a belt-and-braces safety net
   beyond the one the migration already provides — the source is left
   byte-identical by the migration itself, so this is optional.

## Step-by-step: `poc/pdf-rag` as a worked example

The `poc/pdf-rag` POC is a realistic example: a small HTTP server that stores
PDF chunks as embeddings in `.trovec/` plus a sidecar `documents.json` registry
and an `uploads/` directory for the raw PDFs.

### 0. Wire encryption into the app code

Before touching any data, update the app so it wraps its storage driver with
`withEncryption`. For pdf-rag, the relevant lines already read the key from
the environment:

```ts
import { createConcurrentFileDriver, withEncryption } from '@trovec/core';

let driver = createConcurrentFileDriver({ directory: './.trovec', wal: true });
if (process.env.TROVEC_ENCRYPTION_KEY) {
  driver = withEncryption(driver, {
    key: Buffer.from(process.env.TROVEC_ENCRYPTION_KEY, 'hex'),
  });
}
```

You don't set `TROVEC_ENCRYPTION_KEY` yet — that happens in step 6, after the
data has been migrated. With the env var unset, the code path above runs as
plaintext, so the pre-migration server keeps working unchanged.

> For the full API, key-management tradeoffs (raw key vs. password), and
> performance notes, see [Encryption at Rest](../encryption.md).

### 1. Stop the server

```bash
# In the terminal running the pdf-rag server
Ctrl+C
```

### 2. Confirm no writers are attached

```bash
ls poc/pdf-rag/.trovec/*.lock 2>/dev/null
# Expected: no output (no match)
```

If you see a `.lock` file, another process still has the collection open. Stop
that process before continuing.

### 3. Generate and export the new key

```bash
export NEW_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
echo "$NEW_KEY"   # Save this somewhere safe — you'll need it in step 7
```

### 4. Run the migration

```bash
trovec migrate \
  --source poc/pdf-rag/.trovec \
  --new-key "$NEW_KEY"
```

`--source` can be either the directory (Trovec auto-detects the single
`.trovec` file) or the file itself. `--dest` is optional: omit it and the new
encrypted file is written next to the source using the default name
`<source-name>-enc.trovec`. Pass `--dest <file.trovec>` to control the name
explicitly, or `--dest <dir>` to place it in a different directory.

Expected output (approximately):

```
Migrating poc/pdf-rag/.trovec/trovec_1.trovec → poc/pdf-rag/.trovec/trovec_1-enc.trovec
Entries migrated: 247
Source size:      1048576 bytes
Dest size:        1049152 bytes
Migration complete. Source is unchanged; archive it manually when ready.
```

If the source had pending WAL entries (i.e., a `.trovec.wal` sidecar existed),
you'll also see:

```
WAL sidecar detected in source — entries checkpointed into destination.
```

The destination is a single clean base file with no WAL sidecar — the ideal
"just-flushed" starting state for the new deployment.

### 5. Archive the original and promote the encrypted file

The new encrypted file sits alongside the original as `trovec_1-enc.trovec`.
Rename the old one out of the way and promote the new one:

```bash
cd poc/pdf-rag/.trovec
mv trovec_1.trovec      trovec_1.plain.bak
mv trovec_1-enc.trovec  trovec_1.trovec
cd -
```

The plaintext file is preserved as `trovec_1.plain.bak`. Keep it around until
you're confident the new setup works; you can delete it later.

Trovec only encrypts the `.trovec` base file it owns. Adjacent files written
by the application (e.g. pdf-rag's `documents.json` registry and `uploads/`
directory) are not touched and continue to live in `poc/pdf-rag/.trovec/`
unchanged. See [Known limitations](#known-limitations) for what remains in
plaintext on disk.

### 6. Wire up the key and restart

Add the key to `poc/pdf-rag/.env`:

```
TROVEC_ENCRYPTION_KEY=<paste $NEW_KEY here>
```

Start the server:

```bash
cd poc/pdf-rag && npm run dev
```

Check the startup logs for confirmation that encryption is active, then ask a
question against a document you had ingested before the migration to verify
the data round-tripped correctly.

## Rollback plan

If anything goes wrong, the original plaintext file is still there, untouched:

```bash
cd poc/pdf-rag/.trovec
mv trovec_1.trovec       trovec_1-enc.bad.trovec
mv trovec_1.plain.bak    trovec_1.trovec
cd -
# Then remove TROVEC_ENCRYPTION_KEY from poc/pdf-rag/.env
```

Restart the server — it's back to the pre-migration state.

## Known limitations

- **Only the `.trovec` base file is encrypted.** Adjacent application-owned
  files (like pdf-rag's `documents.json` and `uploads/*.pdf`) remain in
  plaintext on disk. If you need those encrypted too, that's an
  application-level change — consider moving the registry data into Trovec as
  entries, or encrypting the `uploads/` directory at the filesystem layer.
- **The key is not stored anywhere Trovec manages.** You are responsible for
  keeping `TROVEC_ENCRYPTION_KEY` safe. Lose it and the collection is
  unreadable.
- **The migration does not lock the source.** It relies on you having stopped
  all writers. The `.lock` pre-flight check catches the common mistake but is
  not a substitute for actually stopping the app.

## Running the migration from a script

For adopters who'd rather run the migration inside their own deploy scripts
than install the CLI:

```ts
import { migrateCollection } from '@trovec/core';

// Write the new encrypted file next to the plaintext original.
await migrateCollection({
  sourceDirectory: './.trovec',
  destDirectory: './.trovec',
  collectionId: 'trovec_1',
  destCollectionId: 'trovec_1-enc', // different name so it doesn't collide
  destEncryption: {
    key: Buffer.from(process.env.NEW_KEY!, 'hex'),
  },
});
```

Or point the destination at a separate directory, in which case
`destCollectionId` can be omitted and the same file name is reused:

```ts
await migrateCollection({
  sourceDirectory: './.trovec',
  destDirectory: './.trovec-encrypted',
  collectionId: 'trovec_1',
  destEncryption: { key: Buffer.from(process.env.NEW_KEY!, 'hex') },
});
```

The options mirror the CLI flags:

- `destCollectionId` — destination file basename. Defaults to `collectionId`.
  Required when source and dest share a directory.
- `sourceEncryption` — provide when the **source** is already encrypted.
- `destEncryption` — provide when the **destination** should be encrypted. Omit
  to write plaintext (e.g. during decryption-for-recovery).
- `force: true` — overwrite an existing destination file.
- `verify: false` — skip the round-trip verification (not recommended).
- `fastRekey: true` — attempt O(1) header-only rekey. Only works when both
  source and destination use encryption and the source is v2 envelope format.
  Falls back to full migration if conditions aren't met (e.g. v1 source or
  WAL sidecar present).
- `upgradeFormat: true` — force the output to v2 envelope format. Allows
  same-key migration (which is otherwise rejected). Useful for explicitly
  upgrading v1 files to v2.

The returned `MigrationResult` includes the entry count, source/dest file
sizes, a `walCheckpointed` flag indicating whether any WAL entries from
the source were folded into the destination, and a `fastRekeyed` flag
indicating whether the O(1) header-only rekey path was used.

## Upgrading from v1 to v2 envelope format

Collections created before v2 envelope encryption use the v1 direct format.
Trovec reads v1 files transparently, so **no migration is required for basic
operation**. However, upgrading to v2 unlocks O(1) fast rekey and
`kekVersionId` tracking.

To upgrade without changing keys:

```bash
trovec migrate \
  --source ./data \
  --encryption-key "$KEY" \
  --new-key "$KEY" \
  --upgrade-format
```

Or programmatically:

```ts
await migrateCollection({
  sourceDirectory: './data',
  destDirectory: './data-v2',
  collectionId: 'my_collection',
  sourceEncryption: { key },
  destEncryption: { key },  // same key is fine
  upgradeFormat: true,
});
```

## Fast rekey (O(1) key rotation)

Once a collection uses v2 envelope format, key rotation can be done in O(1)
time — only the 110-byte header is rewritten, the data ciphertext is
preserved byte-for-byte regardless of collection size.

```bash
trovec migrate \
  --source ./data \
  --encryption-key "$OLD_KEY" \
  --new-key "$NEW_KEY" \
  --fast-rekey
```

Or programmatically:

```ts
const result = await migrateCollection({
  sourceDirectory: './data',
  destDirectory: './data-rekeyed',
  collectionId: 'my_collection',
  sourceEncryption: { key: oldKey },
  destEncryption: { key: newKey },
  fastRekey: true,
});
console.log(result.fastRekeyed); // true
```

Fast rekey falls back to a full migration when:

- The source file is v1 format (upgrade to v2 first)
- A WAL sidecar exists (needs full migration to checkpoint WAL entries)

## Rolling key rotation with previous keys

For zero-downtime key rotation, configure `previousKeys` so the system can
read files encrypted with any previous KEK while writing new files with the
current KEK.

```bash
# Migrate a collection encrypted with OLD_KEY, reading with NEW_KEY + OLD_KEY fallback
trovec migrate \
  --source ./data \
  --encryption-key "$NEW_KEY" \
  --previous-key "$OLD_KEY" \
  --new-key "$NEW_KEY"
```

Or programmatically:

```ts
await migrateCollection({
  sourceDirectory: './data',
  destDirectory: './data-rotated',
  collectionId: 'my_collection',
  sourceEncryption: { key: newKey, previousKeys: [{ key: oldKey }] },
  destEncryption: { key: newKey },
});
```
