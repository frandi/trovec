import { describe, it, expect } from 'vitest';
import { validateConfig, validateEmbedding, validateEntry, validateEntries, serializeId, deserializeId, compareIds } from '../src/validation.js';
import { DimensionMismatchError, InvalidConfigError } from '../src/errors.js';

describe('validateConfig', () => {
  it('applies defaults for quantization and metric', () => {
    const config = validateConfig({ dimensions: 128 });
    expect(config.quantization).toBe('F32');
    expect(config.metric).toBe('cosine');
  });

  it('preserves explicit values', () => {
    const config = validateConfig({ dimensions: 64, quantization: 'INT8', metric: 'euclidean' });
    expect(config.dimensions).toBe(64);
    expect(config.quantization).toBe('INT8');
    expect(config.metric).toBe('euclidean');
  });

  it('throws on zero dimensions', () => {
    expect(() => validateConfig({ dimensions: 0 })).toThrow(InvalidConfigError);
  });

  it('throws on negative dimensions', () => {
    expect(() => validateConfig({ dimensions: -1 })).toThrow(InvalidConfigError);
  });

  it('throws on non-integer dimensions', () => {
    expect(() => validateConfig({ dimensions: 1.5 })).toThrow(InvalidConfigError);
  });

  it('throws on hamming without BIT quantization', () => {
    expect(() => validateConfig({ dimensions: 128, metric: 'hamming', quantization: 'F32' })).toThrow(InvalidConfigError);
  });

  it('allows hamming with BIT quantization', () => {
    const config = validateConfig({ dimensions: 128, metric: 'hamming', quantization: 'BIT' });
    expect(config.metric).toBe('hamming');
    expect(config.quantization).toBe('BIT');
  });
});

describe('validateEmbedding', () => {
  it('accepts correct dimension', () => {
    expect(() => validateEmbedding([1, 2, 3], 3)).not.toThrow();
  });

  it('throws on dimension mismatch', () => {
    expect(() => validateEmbedding([1, 2], 3)).toThrow(DimensionMismatchError);
  });

  it('throws on NaN values', () => {
    expect(() => validateEmbedding([1, NaN, 3], 3)).toThrow(InvalidConfigError);
  });

  it('throws on Infinity values', () => {
    expect(() => validateEmbedding([1, Infinity, 3], 3)).toThrow(InvalidConfigError);
  });
});

describe('validateEntry', () => {
  it('accepts valid string-id entry', () => {
    expect(() => validateEntry({ id: 'a', embedding: [1, 2] }, 2)).not.toThrow();
  });

  it('accepts valid bigint-id entry', () => {
    expect(() => validateEntry({ id: 1n, embedding: [1, 2] }, 2)).not.toThrow();
  });

  it('throws on missing embedding', () => {
    expect(() => validateEntry({ id: 'a' } as any, 2)).toThrow();
  });
});

describe('validateEntries', () => {
  it('accepts all valid entries', () => {
    expect(() => validateEntries([
      { id: 'a', embedding: [1, 2] },
      { id: 'b', embedding: [3, 4] },
    ], 2)).not.toThrow();
  });

  it('throws if any entry is invalid', () => {
    expect(() => validateEntries([
      { id: 'a', embedding: [1, 2] },
      { id: 'b', embedding: [3] }, // wrong dimension
    ], 2)).toThrow();
  });
});

describe('serializeId / deserializeId', () => {
  it('round-trips string ids', () => {
    expect(deserializeId(serializeId('hello'))).toBe('hello');
  });

  it('round-trips bigint ids', () => {
    expect(deserializeId(serializeId(42n))).toBe(42n);
  });

  it('does not collide string "123" with bigint 123n', () => {
    expect(serializeId('123')).not.toBe(serializeId(123n));
  });
});

describe('compareIds', () => {
  it('compares strings lexicographically', () => {
    expect(compareIds('a', 'b')).toBeLessThan(0);
    expect(compareIds('b', 'a')).toBeGreaterThan(0);
    expect(compareIds('a', 'a')).toBe(0);
  });

  it('compares bigints numerically', () => {
    expect(compareIds(1n, 2n)).toBeLessThan(0);
    expect(compareIds(2n, 1n)).toBeGreaterThan(0);
    expect(compareIds(1n, 1n)).toBe(0);
  });

  it('strings sort before bigints', () => {
    expect(compareIds('z', 1n)).toBeLessThan(0);
    expect(compareIds(1n, 'a')).toBeGreaterThan(0);
  });
});
