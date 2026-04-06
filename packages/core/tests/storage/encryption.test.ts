import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createFileDriver } from '../../src/storage/file.js';
import { createMemoryDriver } from '../../src/storage/memory.js';
import { createConcurrentFileDriver } from '../../src/storage/concurrent-file.js';
import {
  withEncryption,
  encryptBuffer,
  encryptBufferV1,
  encryptBufferWithDek,
  decryptBuffer,
  decryptBufferWithDek,
  unwrapDekFromBuffer,
  rekeyBuffer,
  resolveEncryptionKey,
  FORMAT_VERSION_V1,
  FORMAT_VERSION_V2,
  V1_HEADER_SIZE,
  V2_HEADER_SIZE,
} from '../../src/storage/encryption.js';
import { EncryptionError } from '../../src/errors.js';
import { isWalAwareDriver } from '../../src/types.js';
import { create, flush, close } from '../../src/core.js';
import { add, addMany, get } from '../../src/collection.js';
import { query } from '../../src/query.js';

const TEST_KEY = randomBytes(32);
const WRONG_KEY = randomBytes(32);

describe('Encryption primitives', () => {
  it('round-trip with raw key', () => {
    const resolved = resolveEncryptionKey({ key: TEST_KEY });
    const plaintext = Buffer.from('hello world');
    const encrypted = encryptBuffer(plaintext, resolved);
    const decrypted = decryptBuffer(encrypted, resolved);
    expect(decrypted).toEqual(plaintext);
  });

  it('round-trip with password', () => {
    const resolved = resolveEncryptionKey({ password: 'test-password', iterations: 1000 });
    const plaintext = Buffer.from('hello world');
    const encrypted = encryptBuffer(plaintext, resolved);
    const decrypted = decryptBuffer(encrypted, resolved);
    expect(decrypted).toEqual(plaintext);
  });

  it('wrong key fails', () => {
    const resolved = resolveEncryptionKey({ key: TEST_KEY });
    const wrongResolved = resolveEncryptionKey({ key: WRONG_KEY });
    const encrypted = encryptBuffer(Buffer.from('secret'), resolved);
    expect(() => decryptBuffer(encrypted, wrongResolved)).toThrow(EncryptionError);
  });

  it('wrong password fails', () => {
    const resolved = resolveEncryptionKey({ password: 'correct', iterations: 1000 });
    const wrongResolved = resolveEncryptionKey({ password: 'wrong', iterations: 1000 });
    const encrypted = encryptBuffer(Buffer.from('secret'), resolved);
    expect(() => decryptBuffer(encrypted, wrongResolved)).toThrow(EncryptionError);
  });

  it('corrupted ciphertext fails', () => {
    const resolved = resolveEncryptionKey({ key: TEST_KEY });
    const encrypted = encryptBuffer(Buffer.from('secret'), resolved);
    // Flip a byte in the ciphertext area
    encrypted[encrypted.length - 1] ^= 0xff;
    expect(() => decryptBuffer(encrypted, resolved)).toThrow(EncryptionError);
  });

  it('truncated buffer fails', () => {
    const resolved = resolveEncryptionKey({ key: TEST_KEY });
    const truncated = Buffer.alloc(20);
    expect(() => decryptBuffer(truncated, resolved)).toThrow(EncryptionError);
  });

  it('plaintext Trovec buffer surfaces a targeted migration hint', () => {
    const resolved = resolveEncryptionKey({ key: TEST_KEY });
    // First byte 'V' (0x56) is the first byte of the "VCR\x01" magic. The
    // remaining bytes just need to satisfy the minimum-header-size check so
    // that the version branch runs.
    const plaintext = Buffer.alloc(64);
    plaintext[0] = 0x56; // 'V'
    expect(() => decryptBuffer(plaintext, resolved)).toThrow(
      /appears to be an unencrypted Trovec file.*trovec migrate/s,
    );
  });

  it('two encryptions produce different ciphertext', () => {
    const resolved = resolveEncryptionKey({ key: TEST_KEY });
    const plaintext = Buffer.from('same data');
    const enc1 = encryptBuffer(plaintext, resolved);
    const enc2 = encryptBuffer(plaintext, resolved);
    // Full buffers should differ (different DEKs, IVs)
    expect(enc1).not.toEqual(enc2);
  });

  it('large buffer round-trip', () => {
    const resolved = resolveEncryptionKey({ key: TEST_KEY });
    const plaintext = randomBytes(256 * 1024); // 256KB
    const encrypted = encryptBuffer(plaintext, resolved);
    const decrypted = decryptBuffer(encrypted, resolved);
    expect(decrypted).toEqual(plaintext);
  });
});

describe('resolveEncryptionKey validation', () => {
  it('throws if neither key nor password provided', () => {
    expect(() => resolveEncryptionKey({})).toThrow(EncryptionError);
    expect(() => resolveEncryptionKey({})).toThrow('Exactly one of');
  });

  it('throws if both key and password provided', () => {
    expect(() => resolveEncryptionKey({ key: TEST_KEY, password: 'pass' })).toThrow(EncryptionError);
  });

  it('throws if key is not 32 bytes', () => {
    expect(() => resolveEncryptionKey({ key: Buffer.alloc(16) })).toThrow('32 bytes');
    expect(() => resolveEncryptionKey({ key: Buffer.alloc(64) })).toThrow('32 bytes');
  });

  it('throws if password is empty', () => {
    expect(() => resolveEncryptionKey({ password: '' })).toThrow(EncryptionError);
  });
});

describe('withEncryption wrapper', () => {
  it('round-trip with memory driver', async () => {
    const inner = createMemoryDriver();
    const driver = withEncryption(inner, { key: TEST_KEY });

    const data = Buffer.from('test data');
    await driver.write('col1', data);
    const result = await driver.read('col1');
    expect(result).toEqual(data);
  });

  it('round-trip with password', async () => {
    const inner = createMemoryDriver();
    const driver = withEncryption(inner, { password: 'secret', iterations: 1000 });

    const data = Buffer.from('test data');
    await driver.write('col1', data);
    const result = await driver.read('col1');
    expect(result).toEqual(data);
  });

  it('read before write returns null', async () => {
    const inner = createMemoryDriver();
    const driver = withEncryption(inner, { key: TEST_KEY });
    expect(await driver.read('missing')).toBeNull();
  });

  it('exists delegates correctly', async () => {
    const inner = createMemoryDriver();
    const driver = withEncryption(inner, { key: TEST_KEY });

    expect(await driver.exists('col1')).toBe(false);
    await driver.write('col1', Buffer.from('data'));
    expect(await driver.exists('col1')).toBe(true);
  });

  it('delete delegates correctly', async () => {
    const inner = createMemoryDriver();
    const driver = withEncryption(inner, { key: TEST_KEY });

    await driver.write('col1', Buffer.from('data'));
    expect(await driver.delete('col1')).toBe(true);
    expect(await driver.delete('col1')).toBe(false);
  });

  it('is not WAL-aware when wrapping a non-WAL driver', () => {
    const inner = createMemoryDriver();
    const driver = withEncryption(inner, { key: TEST_KEY });
    expect(isWalAwareDriver(driver)).toBe(false);
  });

  it('inner driver stores encrypted data', async () => {
    const inner = createMemoryDriver();
    const driver = withEncryption(inner, { key: TEST_KEY });

    const plaintext = Buffer.from('VCR\x01 sensitive data');
    await driver.write('col1', plaintext);

    // Read raw from inner driver — should be encrypted, not plaintext
    const raw = await inner.read('col1');
    expect(raw).not.toBeNull();
    expect(raw!.includes(Buffer.from('sensitive data'))).toBe(false);
  });
});

describe('withEncryption + file driver integration', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'trovec-enc-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('trovec persist + restore with encrypted file driver', async () => {
    const driver = withEncryption(createFileDriver({ directory: dir }), { key: TEST_KEY });
    const instance = await create({ dimensions: 3, storageDriver: driver, collectionId: 'test', autoFlush: false });

    addMany(instance, [
      { id: 'x', embedding: [1, 2, 3], context: { tag: 'hello' } },
      { id: 'y', embedding: [4, 5, 6] },
    ]);
    await flush(instance);

    // Reopen with same key
    const instance2 = await create({ dimensions: 3, storageDriver: driver, collectionId: 'test', autoFlush: false });
    expect(instance2.entries.size).toBe(2);
    expect(get(instance2, 'x')!.embedding).toEqual([1, 2, 3]);
    expect(get(instance2, 'x')!.context).toEqual({ tag: 'hello' });
    expect(get(instance2, 'y')!.embedding).toEqual([4, 5, 6]);
  });

  it('raw file on disk does not contain plaintext magic bytes', async () => {
    const driver = withEncryption(createFileDriver({ directory: dir }), { key: TEST_KEY });
    const instance = await create({ dimensions: 3, storageDriver: driver, collectionId: 'test', autoFlush: false });
    add(instance, { id: 'a', embedding: [1, 2, 3] });
    await flush(instance);

    const raw = await readFile(join(dir, 'test.trovec'));
    // Should NOT contain the Trovec magic bytes "VCR\x01"
    expect(raw.includes(Buffer.from('VCR\x01'))).toBe(false);
  });

  it('wrong key on reopen throws EncryptionError', async () => {
    const driver = withEncryption(createFileDriver({ directory: dir }), { key: TEST_KEY });
    const instance = await create({ dimensions: 3, storageDriver: driver, collectionId: 'test', autoFlush: false });
    add(instance, { id: 'a', embedding: [1, 2, 3] });
    await flush(instance);

    const wrongDriver = withEncryption(createFileDriver({ directory: dir }), { key: WRONG_KEY });
    await expect(create({ dimensions: 3, storageDriver: wrongDriver, collectionId: 'test', autoFlush: false }))
      .rejects.toThrow(EncryptionError);
  });

  it('query results match after encrypted persist + restore', async () => {
    const driver = withEncryption(createFileDriver({ directory: dir }), { key: TEST_KEY });
    const instance = await create({ dimensions: 3, metric: 'cosine', storageDriver: driver, collectionId: 'test', autoFlush: false });

    add(instance, { id: 'cat', embedding: [1, 0, 0] });
    add(instance, { id: 'dog', embedding: [0.9, 0.1, 0] });
    add(instance, { id: 'car', embedding: [0, 0, 1] });

    const originalResults = query(instance, { vector: [1, 0, 0], topK: 2 });
    await flush(instance);

    const instance2 = await create({ dimensions: 3, metric: 'cosine', storageDriver: driver, collectionId: 'test', autoFlush: false });
    const restoredResults = query(instance2, { vector: [1, 0, 0], topK: 2 });
    expect(restoredResults).toEqual(originalResults);
  });
});

describe('withEncryption + concurrent file driver integration', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'trovec-enc-concurrent-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persist + restore with encryption (WAL disabled)', async () => {
    const driver = withEncryption(createConcurrentFileDriver({ directory: dir }), { key: TEST_KEY });
    const instance = await create({ dimensions: 3, storageDriver: driver, collectionId: 'test', autoFlush: false });

    addMany(instance, [
      { id: 'a', embedding: [1, 2, 3], context: { tag: 'x' } },
      { id: 'b', embedding: [4, 5, 6] },
    ]);
    await flush(instance);

    const instance2 = await create({ dimensions: 3, storageDriver: driver, collectionId: 'test', autoFlush: false });
    expect(instance2.entries.size).toBe(2);
    expect(get(instance2, 'a')!.embedding).toEqual([1, 2, 3]);
    expect(get(instance2, 'a')!.context).toEqual({ tag: 'x' });
  });

  it('raw file on disk is encrypted', async () => {
    const driver = withEncryption(createConcurrentFileDriver({ directory: dir }), { key: TEST_KEY });
    const instance = await create({ dimensions: 3, storageDriver: driver, collectionId: 'test', autoFlush: false });
    add(instance, { id: 'a', embedding: [1, 2, 3] });
    await flush(instance);

    const raw = await readFile(join(dir, 'test.trovec'));
    expect(raw.includes(Buffer.from('VCR\x01'))).toBe(false);
  });

  it('persist + restore with encryption + WAL', async () => {
    const driver = withEncryption(createConcurrentFileDriver({
      directory: dir,
      wal: true,
    }), { key: TEST_KEY });

    // First write — full write (WAL config not ready yet)
    const instance = await create({ dimensions: 3, storageDriver: driver, collectionId: 'test', autoFlush: false });
    add(instance, { id: 'a', embedding: [1, 2, 3], context: { v: 1 } });
    await flush(instance);
    await close(instance);

    // Second instance — WAL config now known, subsequent writes use WAL
    const instance2 = await create({ dimensions: 3, storageDriver: driver, collectionId: 'test', autoFlush: false });
    expect(instance2.entries.size).toBe(1);
    add(instance2, { id: 'b', embedding: [4, 5, 6], context: { v: 2 } });
    await flush(instance2);
    await close(instance2);

    // Third instance — should replay WAL and get both entries
    const instance3 = await create({ dimensions: 3, storageDriver: driver, collectionId: 'test', autoFlush: false });
    expect(instance3.entries.size).toBe(2);
    expect(get(instance3, 'a')!.embedding).toEqual([1, 2, 3]);
    expect(get(instance3, 'b')!.embedding).toEqual([4, 5, 6]);
    await close(instance3);
  });

  it('WAL file is encrypted (no plaintext magic)', async () => {
    const driver = withEncryption(createConcurrentFileDriver({
      directory: dir,
      wal: true,
    }), { key: TEST_KEY });

    const instance = await create({ dimensions: 3, storageDriver: driver, collectionId: 'test', autoFlush: false });
    add(instance, { id: 'a', embedding: [1, 2, 3] });
    await flush(instance);
    await close(instance);

    // Trigger WAL append
    const instance2 = await create({ dimensions: 3, storageDriver: driver, collectionId: 'test', autoFlush: false });
    add(instance2, { id: 'b', embedding: [4, 5, 6] });
    await flush(instance2);

    const walFile = join(dir, 'test.trovec.wal');
    const raw = await readFile(walFile);
    // Should NOT contain the WAL magic bytes "WVCR"
    expect(raw.includes(Buffer.from('WVCR'))).toBe(false);
    await close(instance2);
  });

  it('wrong key on reopen throws EncryptionError', async () => {
    const driver = withEncryption(createConcurrentFileDriver({ directory: dir }), { key: TEST_KEY });
    const instance = await create({ dimensions: 3, storageDriver: driver, collectionId: 'test', autoFlush: false });
    add(instance, { id: 'a', embedding: [1, 2, 3] });
    await flush(instance);

    const wrongDriver = withEncryption(createConcurrentFileDriver({ directory: dir }), { key: WRONG_KEY });
    await expect(create({ dimensions: 3, storageDriver: wrongDriver, collectionId: 'test', autoFlush: false }))
      .rejects.toThrow(EncryptionError);
  });

  it('encryption with password-based key derivation', async () => {
    const driver = withEncryption(createConcurrentFileDriver({
      directory: dir,
    }), { password: 'my-secret', iterations: 1000 });

    const instance = await create({ dimensions: 3, storageDriver: driver, collectionId: 'test', autoFlush: false });
    add(instance, { id: 'a', embedding: [1, 2, 3] });
    await flush(instance);

    const driver2 = withEncryption(createConcurrentFileDriver({
      directory: dir,
    }), { password: 'my-secret', iterations: 1000 });
    const instance2 = await create({ dimensions: 3, storageDriver: driver2, collectionId: 'test', autoFlush: false });
    expect(instance2.entries.size).toBe(1);
    expect(get(instance2, 'a')!.embedding).toEqual([1, 2, 3]);
  });

  it('WAL entries encrypted with DEK not KEK', async () => {
    const driver = withEncryption(createConcurrentFileDriver({
      directory: dir,
      wal: true,
    }), { key: TEST_KEY });

    const instance = await create({ dimensions: 3, storageDriver: driver, collectionId: 'test', autoFlush: false });
    add(instance, { id: 'a', embedding: [1, 2, 3] });
    await flush(instance);
    await close(instance);

    // Trigger WAL append
    const instance2 = await create({ dimensions: 3, storageDriver: driver, collectionId: 'test', autoFlush: false });
    add(instance2, { id: 'b', embedding: [4, 5, 6] });
    await flush(instance2);
    await close(instance2);

    // Extract the DEK from the base file
    const raw = await readFile(join(dir, 'test.trovec'));
    const resolved = resolveEncryptionKey({ key: TEST_KEY });
    const dek = unwrapDekFromBuffer(raw, resolved);

    // DEK should NOT be the same as the KEK
    expect(dek).not.toEqual(TEST_KEY);

    // WAL entries should be decryptable with the DEK (v1 format)
    const walRaw = await readFile(join(dir, 'test.trovec.wal'));
    expect(walRaw.length).toBeGreaterThan(0);
    // WAL entries are individually encrypted with v1 format using the DEK.
    // The WAL file starts with a 4-byte length prefix (unencrypted), then
    // the encrypted header. The encrypted header should start with v1 format byte.
    const headerLen = walRaw.readUInt32LE(0);
    const encHeader = walRaw.subarray(4, 4 + headerLen);
    expect(encHeader[0]).toBe(FORMAT_VERSION_V1);
  });

  it('checkpoint produces encrypted base file', async () => {
    const driver = withEncryption(createConcurrentFileDriver({
      directory: dir,
      wal: true,
      checkpointThreshold: 100,
    }), { key: TEST_KEY });

    const instance = await create({ dimensions: 3, storageDriver: driver, collectionId: 'test', autoFlush: false });
    add(instance, { id: 'a', embedding: [1, 2, 3] });
    await flush(instance);
    await close(instance);

    // Second write triggers WAL
    const instance2 = await create({ dimensions: 3, storageDriver: driver, collectionId: 'test', autoFlush: false });
    add(instance2, { id: 'b', embedding: [4, 5, 6] });
    await flush(instance2);

    // Checkpoint via the WalAwareDriver interface (merge WAL into base)
    const walDriver = driver as unknown as import('../../src/types.js').WalAwareDriver;
    const mergedData = await driver.read('test');
    await walDriver.checkpoint('test', mergedData!);
    await close(instance2);

    // Base file should contain both entries after checkpoint
    const instance3 = await create({ dimensions: 3, storageDriver: driver, collectionId: 'test', autoFlush: false });
    expect(instance3.entries.size).toBe(2);

    // Base file is encrypted
    const raw = await readFile(join(dir, 'test.trovec'));
    expect(raw.includes(Buffer.from('VCR\x01'))).toBe(false);
    await close(instance3);
  });
});

describe('v2 envelope encryption', () => {
  it('encryptBuffer writes v2 format', () => {
    const resolved = resolveEncryptionKey({ key: TEST_KEY });
    const encrypted = encryptBuffer(Buffer.from('data'), resolved);
    expect(encrypted[0]).toBe(FORMAT_VERSION_V2);
  });

  it('v2 round-trip with raw key', () => {
    const resolved = resolveEncryptionKey({ key: TEST_KEY });
    const plaintext = Buffer.from('envelope encryption test');
    const encrypted = encryptBuffer(plaintext, resolved);
    expect(encrypted[0]).toBe(FORMAT_VERSION_V2);
    expect(encrypted.length).toBeGreaterThanOrEqual(V2_HEADER_SIZE);
    const decrypted = decryptBuffer(encrypted, resolved);
    expect(decrypted).toEqual(plaintext);
  });

  it('v2 round-trip with password', () => {
    const resolved = resolveEncryptionKey({ password: 'envelope-pass', iterations: 1000 });
    const plaintext = Buffer.from('password envelope test');
    const encrypted = encryptBuffer(plaintext, resolved);
    expect(encrypted[0]).toBe(FORMAT_VERSION_V2);
    const decrypted = decryptBuffer(encrypted, resolved);
    expect(decrypted).toEqual(plaintext);
  });

  it('v1 backward read compatibility', () => {
    // Create a v1 encrypted buffer and verify decryptBuffer can still read it
    const resolved = resolveEncryptionKey({ key: TEST_KEY });
    const plaintext = Buffer.from('v1 backward compat');
    const v1Encrypted = encryptBufferV1(plaintext, resolved);
    expect(v1Encrypted[0]).toBe(FORMAT_VERSION_V1);
    const decrypted = decryptBuffer(v1Encrypted, resolved);
    expect(decrypted).toEqual(plaintext);
  });

  it('encryptBufferWithDek returns a valid 32-byte DEK', () => {
    const resolved = resolveEncryptionKey({ key: TEST_KEY });
    const plaintext = Buffer.from('dek test');
    const { buffer, dek } = encryptBufferWithDek(plaintext, resolved);
    expect(dek.length).toBe(32);
    expect(buffer[0]).toBe(FORMAT_VERSION_V2);
    // DEK should not be the same as the KEK
    expect(dek).not.toEqual(TEST_KEY);
    // Should still decrypt fine
    const decrypted = decryptBuffer(buffer, resolved);
    expect(decrypted).toEqual(plaintext);
  });

  it('decryptBufferWithDek returns plaintext and DEK', () => {
    const resolved = resolveEncryptionKey({ key: TEST_KEY });
    const plaintext = Buffer.from('dek extract test');
    const { buffer, dek: originalDek } = encryptBufferWithDek(plaintext, resolved);
    const { plaintext: decrypted, dek: extractedDek } = decryptBufferWithDek(buffer, resolved);
    expect(decrypted).toEqual(plaintext);
    expect(extractedDek).toEqual(originalDek);
  });

  it('unwrapDekFromBuffer extracts DEK without decrypting data', () => {
    const resolved = resolveEncryptionKey({ key: TEST_KEY });
    const { buffer, dek: originalDek } = encryptBufferWithDek(Buffer.from('data'), resolved);
    const extractedDek = unwrapDekFromBuffer(buffer, resolved);
    expect(extractedDek).toEqual(originalDek);
  });

  it('unwrapDekFromBuffer rejects v1 input', () => {
    const resolved = resolveEncryptionKey({ key: TEST_KEY });
    const v1Buffer = encryptBufferV1(Buffer.from('v1'), resolved);
    expect(() => unwrapDekFromBuffer(v1Buffer, resolved)).toThrow(EncryptionError);
    expect(() => unwrapDekFromBuffer(v1Buffer, resolved)).toThrow(/v2 format/);
  });

  it('wrong KEK fails on v2', () => {
    const resolved = resolveEncryptionKey({ key: TEST_KEY });
    const wrongResolved = resolveEncryptionKey({ key: WRONG_KEY });
    const encrypted = encryptBuffer(Buffer.from('secret'), resolved);
    expect(() => decryptBuffer(encrypted, wrongResolved)).toThrow(EncryptionError);
  });

  it('truncated v2 header fails', () => {
    const resolved = resolveEncryptionKey({ key: TEST_KEY });
    const truncated = Buffer.alloc(100);
    truncated[0] = FORMAT_VERSION_V2;
    expect(() => decryptBuffer(truncated, resolved)).toThrow(EncryptionError);
  });

  it('large buffer round-trip with v2', () => {
    const resolved = resolveEncryptionKey({ key: TEST_KEY });
    const plaintext = randomBytes(256 * 1024);
    const encrypted = encryptBuffer(plaintext, resolved);
    const decrypted = decryptBuffer(encrypted, resolved);
    expect(decrypted).toEqual(plaintext);
  });

  it('kekVersionId is stored and retrievable from header', () => {
    const resolved = resolveEncryptionKey({ key: TEST_KEY, kekVersionId: 42 });
    const encrypted = encryptBuffer(Buffer.from('data'), resolved);
    // kekVersionId is at bytes [2..5] as uint32 LE
    const storedVersion = encrypted.readUInt32LE(2);
    expect(storedVersion).toBe(42);
  });
});

describe('v2 AAD tampering detection', () => {
  it('flipping version byte causes decryption failure', () => {
    const resolved = resolveEncryptionKey({ key: TEST_KEY });
    const encrypted = encryptBuffer(Buffer.from('aad test'), resolved);
    // Flip version byte — AAD won't match
    encrypted[0] = 0xFF;
    expect(() => decryptBuffer(encrypted, resolved)).toThrow(EncryptionError);
  });

  it('flipping keyMode byte causes decryption failure', () => {
    const resolved = resolveEncryptionKey({ key: TEST_KEY });
    const encrypted = encryptBuffer(Buffer.from('aad test'), resolved);
    // Flip key mode byte
    encrypted[1] ^= 0xFF;
    expect(() => decryptBuffer(encrypted, resolved)).toThrow(EncryptionError);
  });

  it('modifying kekVersionId causes decryption failure', () => {
    const resolved = resolveEncryptionKey({ key: TEST_KEY, kekVersionId: 1 });
    const encrypted = encryptBuffer(Buffer.from('aad test'), resolved);
    // Modify kekVersionId in header
    encrypted.writeUInt32LE(999, 2);
    expect(() => decryptBuffer(encrypted, resolved)).toThrow(EncryptionError);
  });
});

describe('rekeyBuffer', () => {
  it('rekey from keyA to keyB, decrypt with keyB succeeds', () => {
    const keyA = randomBytes(32);
    const keyB = randomBytes(32);
    const resolvedA = resolveEncryptionKey({ key: keyA });
    const resolvedB = resolveEncryptionKey({ key: keyB });

    const plaintext = Buffer.from('rekey test data');
    const encrypted = encryptBuffer(plaintext, resolvedA);
    const rekeyed = rekeyBuffer(resolvedA, resolvedB, encrypted);

    // Decrypt with new key succeeds
    const decrypted = decryptBuffer(rekeyed, resolvedB);
    expect(decrypted).toEqual(plaintext);

    // Decrypt with old key fails
    expect(() => decryptBuffer(rekeyed, resolvedA)).toThrow(EncryptionError);
  });

  it('preserves data bytes (offset 82+ identical)', () => {
    const keyA = randomBytes(32);
    const keyB = randomBytes(32);
    const resolvedA = resolveEncryptionKey({ key: keyA });
    const resolvedB = resolveEncryptionKey({ key: keyB });

    const encrypted = encryptBuffer(Buffer.from('preserve data section'), resolvedA);
    const rekeyed = rekeyBuffer(resolvedA, resolvedB, encrypted);

    // Data section (from offset 82) must be identical
    expect(rekeyed.subarray(82)).toEqual(encrypted.subarray(82));

    // Header section (0..81) must differ (new KEK IV, auth tag, etc.)
    expect(rekeyed.subarray(0, 82)).not.toEqual(encrypted.subarray(0, 82));
  });

  it('rejects v1 input', () => {
    const resolved = resolveEncryptionKey({ key: TEST_KEY });
    const v1 = encryptBufferV1(Buffer.from('v1'), resolved);
    expect(() => rekeyBuffer(resolved, resolved, v1)).toThrow(EncryptionError);
    expect(() => rekeyBuffer(resolved, resolved, v1)).toThrow(/v2 format/);
  });

  it('rekey with password-based KEKs', () => {
    const resolvedA = resolveEncryptionKey({ password: 'old-pass', iterations: 1000 });
    const resolvedB = resolveEncryptionKey({ password: 'new-pass', iterations: 1000 });

    const plaintext = Buffer.from('password rekey');
    const encrypted = encryptBuffer(plaintext, resolvedA);
    const rekeyed = rekeyBuffer(resolvedA, resolvedB, encrypted);

    expect(decryptBuffer(rekeyed, resolvedB)).toEqual(plaintext);
    expect(() => decryptBuffer(rekeyed, resolvedA)).toThrow(EncryptionError);
  });

  it('updates kekVersionId', () => {
    const resolvedA = resolveEncryptionKey({ key: TEST_KEY, kekVersionId: 1 });
    const resolvedB = resolveEncryptionKey({ key: randomBytes(32), kekVersionId: 2 });

    const encrypted = encryptBuffer(Buffer.from('version'), resolvedA);
    expect(encrypted.readUInt32LE(2)).toBe(1);

    const rekeyed = rekeyBuffer(resolvedA, resolvedB, encrypted);
    expect(rekeyed.readUInt32LE(2)).toBe(2);
  });
});

describe('previousKeys rolling rotation', () => {
  it('decrypt with previousKeys when primary key fails', () => {
    const keyA = randomBytes(32);
    const keyB = randomBytes(32);
    const resolvedA = resolveEncryptionKey({ key: keyA });

    const encrypted = encryptBuffer(Buffer.from('rolling'), resolvedA);

    // Decrypt with keyB as primary, keyA as previous
    const resolvedB = resolveEncryptionKey({
      key: keyB,
      previousKeys: [{ key: keyA }],
    });
    const decrypted = decryptBuffer(encrypted, resolvedB);
    expect(decrypted).toEqual(Buffer.from('rolling'));
  });

  it('primary key is tried first', () => {
    const key = randomBytes(32);
    const resolved = resolveEncryptionKey({ key, previousKeys: [{ key: randomBytes(32) }] });

    const encrypted = encryptBuffer(Buffer.from('primary first'), resolved);
    // Should succeed with primary key (no need to try previous)
    const decrypted = decryptBuffer(encrypted, resolved);
    expect(decrypted).toEqual(Buffer.from('primary first'));
  });

  it('all keys fail throws EncryptionError', () => {
    const keyA = randomBytes(32);
    const resolvedA = resolveEncryptionKey({ key: keyA });
    const encrypted = encryptBuffer(Buffer.from('fail'), resolvedA);

    const resolvedWrong = resolveEncryptionKey({
      key: randomBytes(32),
      previousKeys: [{ key: randomBytes(32) }, { key: randomBytes(32) }],
    });
    expect(() => decryptBuffer(encrypted, resolvedWrong)).toThrow(EncryptionError);
  });

  it('previousKeys with password mode', () => {
    const resolvedOld = resolveEncryptionKey({ password: 'old', iterations: 1000 });
    const encrypted = encryptBuffer(Buffer.from('pw rolling'), resolvedOld);

    const resolvedNew = resolveEncryptionKey({
      password: 'new',
      iterations: 1000,
      previousKeys: [{ password: 'old', iterations: 1000 }],
    });
    const decrypted = decryptBuffer(encrypted, resolvedNew);
    expect(decrypted).toEqual(Buffer.from('pw rolling'));
  });
});

describe('resolveEncryptionKey v2 validation', () => {
  it('accepts kekVersionId', () => {
    const resolved = resolveEncryptionKey({ key: TEST_KEY, kekVersionId: 42 });
    expect(resolved.kekVersionId).toBe(42);
  });

  it('defaults kekVersionId to 0', () => {
    const resolved = resolveEncryptionKey({ key: TEST_KEY });
    expect(resolved.kekVersionId).toBe(0);
  });

  it('rejects invalid kekVersionId', () => {
    expect(() => resolveEncryptionKey({ key: TEST_KEY, kekVersionId: -1 })).toThrow(EncryptionError);
    expect(() => resolveEncryptionKey({ key: TEST_KEY, kekVersionId: 0x100000000 })).toThrow(EncryptionError);
    expect(() => resolveEncryptionKey({ key: TEST_KEY, kekVersionId: 1.5 })).toThrow(EncryptionError);
  });

  it('validates previousKeys entries', () => {
    expect(() => resolveEncryptionKey({
      key: TEST_KEY,
      previousKeys: [{}], // neither key nor password
    })).toThrow(EncryptionError);

    expect(() => resolveEncryptionKey({
      key: TEST_KEY,
      previousKeys: [{ key: Buffer.alloc(16) }], // wrong size
    })).toThrow(EncryptionError);
  });
});
