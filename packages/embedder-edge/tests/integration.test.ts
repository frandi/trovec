// End-to-end tests against the real bundled ONNX model.
//
// Run with: npm run test:integration --workspace=packages/embedder-edge
// Excluded from the default `npm test` because they load a 32 MB model.

import { describe, it, expect } from 'vitest';
import { createEdgeEmbedder } from '../src/edge-embedder.js';

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

describe('edge embedder integration (real model)', () => {
  it('factory returns synchronously without blocking on model load', () => {
    const start = Date.now();
    const embedder = createEdgeEmbedder();
    const elapsed = Date.now() - start;
    expect(embedder).toBeDefined();
    expect(elapsed).toBeLessThan(50);
  });

  it('embed() returns a 384-dimensional unit vector', async () => {
    const embedder = createEdgeEmbedder();
    const { embedding } = await embedder.embed('hello world');
    expect(embedding).toHaveLength(384);
    const norm = Math.sqrt(dot(embedding, embedding));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('the same input produces the same vector (determinism)', async () => {
    const embedder = createEdgeEmbedder();
    const a = (await embedder.embed('determinism check')).embedding;
    const b = (await embedder.embed('determinism check')).embedding;
    for (let i = 0; i < a.length; i++) {
      expect(a[i]).toBeCloseTo(b[i], 6);
    }
  });

  it('similar sentences score higher than unrelated ones', async () => {
    const embedder = createEdgeEmbedder();
    const [pets1, pets2, code] = (
      await embedder.embedMany([
        'cats and dogs are popular pets',
        'common household pets include cats and dogs',
        'TypeScript is a typed superset of JavaScript',
      ])
    ).map((r) => r.embedding);

    const similar = dot(pets1, pets2);
    const unrelatedA = dot(pets1, code);
    const unrelatedB = dot(pets2, code);
    expect(similar).toBeGreaterThan(unrelatedA);
    expect(similar).toBeGreaterThan(unrelatedB);
  });

  it('embedMany returns one vector per input and matches single-input embed for each', async () => {
    const embedder = createEdgeEmbedder();
    const inputs = ['alpha', 'beta gamma', 'a much longer sentence than the others to vary length'];
    const batch = await embedder.embedMany(inputs);
    expect(batch).toHaveLength(inputs.length);

    for (let i = 0; i < inputs.length; i++) {
      const single = (await embedder.embed(inputs[i])).embedding;
      // Cosine similarity should be very high between batched and single-input
      // runs of the same text. The bound is 0.99 (not 1.0) because INT8
      // quantization amplifies small numerical differences introduced by
      // padding tokens in the batched run — practically invisible for retrieval
      // ranking but visible to direct vector comparison.
      const sim = dot(single, batch[i].embedding);
      expect(sim).toBeGreaterThan(0.99);
    }
  });

  it('exposes a versioned model identity used by core mismatch warnings', () => {
    const embedder = createEdgeEmbedder();
    expect(embedder.model).toBe('bge-small-en-v1.5@1.0.0');
  });
});
