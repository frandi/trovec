import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createFileDriver } from '../../src/storage/file.js';
import { createMemoryDriver } from '../../src/storage/memory.js';
import { createConcurrentFileDriver } from '../../src/storage/concurrent-file.js';
import { withEncryption, encryptBuffer, decryptBuffer, resolveEncryptionKey } from '../../src/storage/encryption.js';
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

  it('two encryptions produce different ciphertext', () => {
    const resolved = resolveEncryptionKey({ key: TEST_KEY });
    const plaintext = Buffer.from('same data');
    const enc1 = encryptBuffer(plaintext, resolved);
    const enc2 = encryptBuffer(plaintext, resolved);
    // IVs at offset 18..29 should differ
    expect(enc1.subarray(18, 30)).not.toEqual(enc2.subarray(18, 30));
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
