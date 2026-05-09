export function randomVector(dimensions: number): number[] {
  const vec = new Array<number>(dimensions);
  for (let i = 0; i < dimensions; i++) {
    vec[i] = Math.random() * 2 - 1;
  }
  return vec;
}

export function zeroVector(dimensions: number): number[] {
  return new Array<number>(dimensions).fill(0);
}

export function constantVector(dimensions: number, value: number): number[] {
  return new Array<number>(dimensions).fill(value);
}

export function expectClose(actual: number, expected: number, tolerance = 1e-6): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`Expected ${actual} to be close to ${expected} (tolerance: ${tolerance})`);
  }
}

import type { Embedder } from '../src/types.js';

/**
 * A simple deterministic mock embedder for tests.
 * Hashes input chars into a fixed-dimension vector. Optionally tags `model`
 * so tests can verify embedder identity propagation.
 */
export function createMockEmbedder(dims: number, model?: string): Embedder {
  return {
    get dimensions() {
      return dims;
    },
    get model() {
      return model;
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
