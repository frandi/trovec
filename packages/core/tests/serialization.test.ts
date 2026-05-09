import { describe, it, expect } from 'vitest';
import { create } from '../src/core.js';
import { add, addMany, get } from '../src/collection.js';
import { serialize, deserialize } from '../src/serialization.js';
import { createMockEmbedder } from './helpers.js';

/**
 * Build a v1 buffer (no metadata section) for backward-compat tests.
 * Mirrors the legacy v1 binary layout exactly so deserialize must read it
 * without falling into the v2 metadata branch.
 */
function buildV1Buffer(args: {
  dimensions: number;
  /** quantization enum byte: 0=F32, 1=INT8, 2=BIT */
  quantization: number;
  /** metric enum byte: 0=cosine, 1=euclidean, 2=dot, 3=hamming */
  metric: number;
  /** entries pre-encoded with their post-id payload (quantized + context) */
  entries: { id: string; quantizedAndContext: Buffer }[];
}): Buffer {
  const HEADER_SIZE = 16;
  const MAGIC = Buffer.from('VCR\x01');
  const idBufs = args.entries.map((e) => Buffer.from(e.id, 'utf-8'));
  const totalEntrySize = args.entries.reduce(
    (n, e, i) => n + 1 + 4 + idBufs[i].length + e.quantizedAndContext.length,
    0,
  );
  const buf = Buffer.alloc(HEADER_SIZE + totalEntrySize);
  let offset = 0;
  MAGIC.copy(buf, offset); offset += 4;
  buf.writeUInt8(1, offset); offset += 1; // version 1
  buf.writeUInt32LE(args.dimensions, offset); offset += 4;
  buf.writeUInt8(args.quantization, offset); offset += 1;
  buf.writeUInt8(args.metric, offset); offset += 1;
  buf.writeUInt32LE(args.entries.length, offset); offset += 4;
  buf.writeUInt8(0, offset); offset += 1; // reserved
  for (let i = 0; i < args.entries.length; i++) {
    buf.writeUInt8(0, offset); offset += 1; // id type: string
    buf.writeUInt32LE(idBufs[i].length, offset); offset += 4;
    idBufs[i].copy(buf, offset); offset += idBufs[i].length;
    args.entries[i].quantizedAndContext.copy(buf, offset);
    offset += args.entries[i].quantizedAndContext.length;
  }
  return buf;
}

describe('serialization', () => {
  it('round-trips F32 entries', async () => {
    const instance = await create({ dimensions: 3 });
    addMany(instance, [
      { id: 'a', embedding: [1, 2, 3], context: { label: 'first' } },
      { id: 'b', embedding: [4, 5, 6] },
    ]);

    const buffer = serialize(instance);

    const instance2 = await create({ dimensions: 3 });
    deserialize(buffer, instance2);

    expect(instance2.entries.size).toBe(2);
    const a = get(instance2, 'a');
    expect(a!.embedding).toEqual([1, 2, 3]);
    expect(a!.context).toEqual({ label: 'first' });
    const b = get(instance2, 'b');
    expect(b!.embedding).toEqual([4, 5, 6]);
    expect(b!.context).toBeUndefined();
  });

  it('round-trips INT8 entries', async () => {
    const instance = await create({ dimensions: 3, quantization: 'INT8' });
    add(instance, { id: 'a', embedding: [0.1, 0.5, 0.9] });

    const buffer = serialize(instance);

    const instance2 = await create({ dimensions: 3, quantization: 'INT8' });
    deserialize(buffer, instance2);

    const a = get(instance2, 'a');
    expect(a).toBeDefined();
    expect(a!.embedding[0]).toBeCloseTo(0.1, 1);
    expect(a!.embedding[1]).toBeCloseTo(0.5, 1);
    expect(a!.embedding[2]).toBeCloseTo(0.9, 1);
  });

  it('round-trips BIT entries', async () => {
    const instance = await create({ dimensions: 8, quantization: 'BIT', metric: 'hamming' });
    add(instance, { id: 'a', embedding: [1, -1, 1, -1, 1, -1, 1, -1] });

    const buffer = serialize(instance);

    const instance2 = await create({ dimensions: 8, quantization: 'BIT', metric: 'hamming' });
    deserialize(buffer, instance2);

    const a = get(instance2, 'a');
    expect(a!.embedding).toEqual([1, -1, 1, -1, 1, -1, 1, -1]);
  });

  it('round-trips bigint ids', async () => {
    const instance = await create({ dimensions: 2 });
    add(instance, { id: 42n, embedding: [1, 2] });

    const buffer = serialize(instance);

    const instance2 = await create({ dimensions: 2 });
    deserialize(buffer, instance2);

    const entry = get(instance2, 42n);
    expect(entry).toBeDefined();
    expect(entry!.id).toBe(42n);
  });

  it('round-trips entries with no context', async () => {
    const instance = await create({ dimensions: 2 });
    add(instance, { id: 'a', embedding: [1, 2] });

    const buffer = serialize(instance);

    const instance2 = await create({ dimensions: 2 });
    deserialize(buffer, instance2);

    const a = get(instance2, 'a');
    expect(a!.context).toBeUndefined();
  });

  it('throws on dimension mismatch', async () => {
    const instance1 = await create({ dimensions: 3 });
    add(instance1, { id: 'a', embedding: [1, 2, 3] });
    const buffer = serialize(instance1);

    const instance2 = await create({ dimensions: 5 });
    expect(() => deserialize(buffer, instance2)).toThrow(/Dimension mismatch/);
  });

  it('throws on invalid magic bytes', async () => {
    const instance = await create({ dimensions: 2 });
    const buffer = Buffer.alloc(16);
    expect(() => deserialize(buffer, instance)).toThrow(/Invalid magic/);
  });

  describe('format v2 metadata', () => {
    it('writes a v2 header byte', async () => {
      const instance = await create({ dimensions: 3 });
      add(instance, { id: 'a', embedding: [1, 2, 3] });
      const buffer = serialize(instance);
      expect(buffer.readUInt8(4)).toBe(2);
    });

    it('writes empty JSON metadata when no embedder is configured', async () => {
      const instance = await create({ dimensions: 3 });
      add(instance, { id: 'a', embedding: [1, 2, 3] });
      const buffer = serialize(instance);

      const metadataLen = buffer.readUInt16LE(16);
      expect(metadataLen).toBe(2);
      const metadataStr = buffer.toString('utf-8', 18, 18 + metadataLen);
      expect(JSON.parse(metadataStr)).toEqual({});
    });

    it('writes embedder identity when an embedder with a model is configured', async () => {
      const embedder = createMockEmbedder(3, 'mock-model@1.0.0');
      const instance = await create({ embedder });
      add(instance, { id: 'a', embedding: [1, 2, 3] });
      const buffer = serialize(instance);

      const metadataLen = buffer.readUInt16LE(16);
      const metadataStr = buffer.toString('utf-8', 18, 18 + metadataLen);
      expect(JSON.parse(metadataStr)).toEqual({ embedderId: 'mock-model@1.0.0' });
    });

    it('omits embedderId when embedder has no model field', async () => {
      const embedder = createMockEmbedder(3); // no model
      const instance = await create({ embedder });
      add(instance, { id: 'a', embedding: [1, 2, 3] });
      const buffer = serialize(instance);

      const metadataLen = buffer.readUInt16LE(16);
      const metadataStr = buffer.toString('utf-8', 18, 18 + metadataLen);
      expect(JSON.parse(metadataStr)).toEqual({});
    });

    it('round-trips embedder identity through deserialize', async () => {
      const embedderA = createMockEmbedder(3, 'embedder-a@2.1.0');
      const instanceA = await create({ embedder: embedderA });
      add(instanceA, { id: 'a', embedding: [1, 2, 3] });
      const buffer = serialize(instanceA);

      const instanceB = await create({ dimensions: 3 });
      const metadata = deserialize(buffer, instanceB);
      expect(metadata).not.toBeNull();
      expect(metadata?.embedderId).toBe('embedder-a@2.1.0');
      expect(get(instanceB, 'a')!.embedding).toEqual([1, 2, 3]);
    });

    it('returns empty metadata object for v2 files with no embedder', async () => {
      const instance = await create({ dimensions: 3 });
      add(instance, { id: 'a', embedding: [1, 2, 3] });
      const buffer = serialize(instance);

      const target = await create({ dimensions: 3 });
      const metadata = deserialize(buffer, target);
      expect(metadata).toEqual({});
    });
  });

  describe('format v1 backward compatibility', () => {
    it('reads a hand-crafted v1 buffer (F32, no metadata section)', async () => {
      // Build a v1 F32 buffer with one entry: id="a", embedding=[1,2,3], no context.
      const quantizedAndContext = Buffer.alloc(3 * 8 + 4);
      let off = 0;
      quantizedAndContext.writeDoubleLE(1, off); off += 8;
      quantizedAndContext.writeDoubleLE(2, off); off += 8;
      quantizedAndContext.writeDoubleLE(3, off); off += 8;
      quantizedAndContext.writeUInt32LE(0, off); // empty context

      const buffer = buildV1Buffer({
        dimensions: 3,
        quantization: 0, // F32
        metric: 0,       // cosine
        entries: [{ id: 'a', quantizedAndContext }],
      });

      const instance = await create({ dimensions: 3 });
      const metadata = deserialize(buffer, instance);
      expect(metadata).toBeNull(); // v1 files have no metadata
      expect(instance.entries.size).toBe(1);
      expect(get(instance, 'a')!.embedding).toEqual([1, 2, 3]);
    });
  });

  describe('format version errors', () => {
    it('throws on an unsupported future version', async () => {
      const instance = await create({ dimensions: 3 });
      add(instance, { id: 'a', embedding: [1, 2, 3] });
      const buffer = serialize(instance);
      buffer.writeUInt8(99, 4); // crash future version into the version byte
      expect(() => deserialize(buffer, instance)).toThrow(/Unsupported version: 99/);
    });
  });
});
