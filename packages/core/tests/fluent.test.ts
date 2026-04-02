import { describe, it, expect } from 'vitest';
import { create, flush, stats, add, addMany, get, delete as del, query, serialize, deserialize, addWithText, addManyWithText, queryByText } from '../src/index.js';
import type { Embedder, Trovec } from '../src/types.js';

function createMockEmbedder(dims: number): Embedder {
  return {
    get dimensions() {
      return dims;
    },
    async embed(input: string) {
      const embedding = new Array(dims).fill(0);
      for (let i = 0; i < input.length; i++) {
        embedding[i % dims] += input.charCodeAt(i) / 1000;
      }
      return { embedding };
    },
    async embedMany(inputs: string[]) {
      const results = [];
      for (const input of inputs) {
        results.push(await this.embed(input));
      }
      return results;
    },
  };
}

async function createDb(opts?: { embedder?: boolean }): Promise<Trovec> {
  return create({
    dimensions: 3,
    embedder: opts?.embedder ? createMockEmbedder(3) : undefined,
  });
}

describe('fluent API', () => {
  it('create() returns object with all expected methods', async () => {
    const db = await createDb();

    expect(typeof db.add).toBe('function');
    expect(typeof db.addMany).toBe('function');
    expect(typeof db.get).toBe('function');
    expect(typeof db.delete).toBe('function');
    expect(typeof db.query).toBe('function');
    expect(typeof db.stats).toBe('function');
    expect(typeof db.flush).toBe('function');
    expect(typeof db.close).toBe('function');
    expect(typeof db.embed).toBe('function');
    expect(typeof db.embedMany).toBe('function');
    expect(typeof db.addWithText).toBe('function');
    expect(typeof db.addManyWithText).toBe('function');
    expect(typeof db.queryByText).toBe('function');
    expect(typeof db.serialize).toBe('function');
    expect(typeof db.deserialize).toBe('function');
  });

  it('retains TrovecInstance data properties', async () => {
    const db = await createDb();
    expect(db.config).toBeDefined();
    expect(db.config.dimensions).toBe(3);
    expect(db.entries).toBeInstanceOf(Map);
    expect(db.codec).toBeDefined();
    expect(db.similarityFn).toBeDefined();
  });

  describe('collection methods', () => {
    it('add and get', async () => {
      const db = await createDb();
      db.add({ id: 'a', embedding: [1, 2, 3] });

      const entry = db.get('a');
      expect(entry).toBeDefined();
      expect(entry!.id).toBe('a');
    });

    it('addMany', async () => {
      const db = await createDb();
      db.addMany([
        { id: 'a', embedding: [1, 2, 3] },
        { id: 'b', embedding: [4, 5, 6] },
      ]);
      expect(db.stats().entryCount).toBe(2);
    });

    it('delete', async () => {
      const db = await createDb();
      db.add({ id: 'a', embedding: [1, 2, 3] });
      expect(db.delete('a')).toBe(true);
      expect(db.get('a')).toBeUndefined();
    });
  });

  describe('query', () => {
    it('returns results', async () => {
      const db = await createDb();
      db.add({ id: 'a', embedding: [1, 0, 0] });
      db.add({ id: 'b', embedding: [0, 1, 0] });

      const results = db.query({ vector: [1, 0, 0], topK: 1 });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('a');
    });
  });

  describe('stats and flush', () => {
    it('stats returns correct count', async () => {
      const db = await createDb();
      db.add({ id: 'x', embedding: [1, 2, 3] });
      const s = db.stats();
      expect(s.entryCount).toBe(1);
      expect(s.dimensions).toBe(3);
    });

    it('flush does not throw', async () => {
      const db = await createDb();
      await expect(db.flush()).resolves.toBeUndefined();
    });
  });

  describe('embedder methods', () => {
    it('embed and embedMany', async () => {
      const db = await createDb({ embedder: true });

      const result = await db.embed('hello');
      expect(result.embedding).toHaveLength(3);

      const results = await db.embedMany(['a', 'b']);
      expect(results).toHaveLength(2);
    });

    it('addWithText and get', async () => {
      const db = await createDb({ embedder: true });

      await db.addWithText({ id: 'doc1', text: 'hello world' });
      expect(db.get('doc1')).toBeDefined();
    });

    it('addManyWithText', async () => {
      const db = await createDb({ embedder: true });

      await db.addManyWithText([
        { id: 'a', text: 'hello' },
        { id: 'b', text: 'world', context: { tag: 'test' } },
      ]);
      expect(db.stats().entryCount).toBe(2);
      expect(db.get('b')!.context).toEqual({ tag: 'test' });
    });

    it('queryByText', async () => {
      const db = await createDb({ embedder: true });

      await db.addWithText({ id: 'doc1', text: 'hello world' });
      await db.addWithText({ id: 'doc2', text: 'foo bar baz' });

      const results = await db.queryByText({ text: 'hello world', topK: 1 });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('doc1');
    });
  });

  describe('serialization', () => {
    it('serialize and deserialize roundtrip', async () => {
      const db = await createDb();
      db.add({ id: 'a', embedding: [1, 2, 3], context: { foo: 'bar' } });
      db.add({ id: 'b', embedding: [4, 5, 6] });

      const buffer = db.serialize();
      expect(buffer).toBeInstanceOf(Buffer);

      const db2 = await createDb();
      db2.deserialize(buffer);

      expect(db2.stats().entryCount).toBe(2);
      expect(db2.get('a')!.context).toEqual({ foo: 'bar' });
    });
  });

  describe('backward compatibility', () => {
    it('Trovec objects work with functional API', async () => {
      const db = await createDb();

      // Use functional API with the Trovec object
      add(db, { id: 'a', embedding: [1, 2, 3] });
      expect(get(db, 'a')).toBeDefined();
      expect(stats(db).entryCount).toBe(1);

      const results = query(db, { vector: [1, 2, 3], topK: 1 });
      expect(results).toHaveLength(1);

      expect(del(db, 'a')).toBe(true);
    });

    it('Trovec objects work with functional embedder API', async () => {
      const db = await createDb({ embedder: true });

      await addWithText(db, { id: 'doc1', text: 'hello' });
      await addManyWithText(db, [{ id: 'doc2', text: 'world' }]);

      const results = await queryByText(db, { text: 'hello', topK: 1 });
      expect(results).toHaveLength(1);
    });

    it('functional serialize/deserialize works with Trovec', async () => {
      const db = await createDb();
      add(db, { id: 'x', embedding: [1, 2, 3] });

      const buffer = serialize(db);
      const db2 = await createDb();
      deserialize(buffer, db2);

      expect(stats(db2).entryCount).toBe(1);
    });
  });
});
