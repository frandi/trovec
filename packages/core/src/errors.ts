export class TrovecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrovecError';
  }
}

export class DimensionMismatchError extends TrovecError {
  constructor(expected: number, got: number) {
    super(`Expected embedding of dimension ${expected} but got ${got}`);
    this.name = 'DimensionMismatchError';
  }
}

export class InvalidConfigError extends TrovecError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidConfigError';
  }
}
