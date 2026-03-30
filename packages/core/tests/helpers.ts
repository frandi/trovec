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
