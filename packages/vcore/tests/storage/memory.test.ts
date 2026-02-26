import { describe, it, expect } from 'vitest';
import { createMemoryDriver } from '../../src/storage/memory.js';

describe('MemoryStorageDriver', () => {
  it('write then read returns same buffer', async () => {
    const driver = createMemoryDriver();
    const data = Buffer.from('hello');
    await driver.write('col1', data);
    const result = await driver.read('col1');
    expect(result).toEqual(data);
  });

  it('read non-existent returns null', async () => {
    const driver = createMemoryDriver();
    expect(await driver.read('missing')).toBeNull();
  });

  it('exists returns correct boolean', async () => {
    const driver = createMemoryDriver();
    expect(await driver.exists('col1')).toBe(false);
    await driver.write('col1', Buffer.from('data'));
    expect(await driver.exists('col1')).toBe(true);
  });

  it('delete returns true if existed', async () => {
    const driver = createMemoryDriver();
    await driver.write('col1', Buffer.from('data'));
    expect(await driver.delete('col1')).toBe(true);
    expect(await driver.exists('col1')).toBe(false);
  });

  it('delete returns false if not existed', async () => {
    const driver = createMemoryDriver();
    expect(await driver.delete('missing')).toBe(false);
  });

  it('overwrites existing key', async () => {
    const driver = createMemoryDriver();
    await driver.write('col1', Buffer.from('first'));
    await driver.write('col1', Buffer.from('second'));
    const result = await driver.read('col1');
    expect(result?.toString()).toBe('second');
  });
});
