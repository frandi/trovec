/** Base error class for all Trovec errors. */
export class TrovecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrovecError';
  }
}

/** Thrown when an embedding vector's length does not match the configured dimensions. */
export class DimensionMismatchError extends TrovecError {
  constructor(expected: number, got: number) {
    super(`Expected embedding of dimension ${expected} but got ${got}`);
    this.name = 'DimensionMismatchError';
  }
}

/** Thrown when a Trovec configuration or entry is invalid. */
export class InvalidConfigError extends TrovecError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidConfigError';
  }
}
