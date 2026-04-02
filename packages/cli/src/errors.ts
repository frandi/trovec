export class CliError extends Error {
  constructor(
    message: string,
    public hint?: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export function handleError(err: unknown): never {
  if (err instanceof CliError) {
    process.stderr.write(`Error: ${err.message}\n`);
    if (err.hint) {
      process.stderr.write(`Hint: ${err.hint}\n`);
    }
    process.exit(1);
  }

  // Map known trovec errors
  if (err instanceof Error) {
    const name = err.constructor.name;

    if (name === 'InvalidConfigError') {
      process.stderr.write(`Error: Invalid config -- ${err.message}\n`);
      process.stderr.write(`Hint: Run "trovec init" to set up your project.\n`);
      process.exit(1);
    }

    if (name === 'DimensionMismatchError') {
      process.stderr.write(`Error: Dimension mismatch -- ${err.message}\n`);
      process.stderr.write(`Hint: Check your embedder config matches the collection dimensions.\n`);
      process.exit(1);
    }

    // Generic error
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }

  process.stderr.write(`Error: ${String(err)}\n`);
  process.exit(1);
}
