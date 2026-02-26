export class VCoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VCoreError';
  }
}

export class DimensionMismatchError extends VCoreError {
  constructor(expected: number, got: number) {
    super(`Expected embedding of dimension ${expected} but got ${got}`);
    this.name = 'DimensionMismatchError';
  }
}

export class InvalidConfigError extends VCoreError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidConfigError';
  }
}
