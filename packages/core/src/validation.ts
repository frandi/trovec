import type { EntryId, Entry, TrovecConfig, ResolvedTrovecConfig, StorageDriver } from './types.js';
import { DimensionMismatchError, InvalidConfigError } from './errors.js';

let instanceCounter = 0;

const BIGINT_PREFIX = '__bigint__:';

const nullDriver: StorageDriver = {
  async write() {},
  async read() { return null; },
  async exists() { return false; },
  async delete() { return false; },
};

export function validateConfig(config: TrovecConfig): ResolvedTrovecConfig {
  // Resolve dimensions: explicit config takes priority, then embedder, then error
  let dimensions: number;
  if (config.dimensions != null) {
    if (!Number.isInteger(config.dimensions) || config.dimensions <= 0) {
      throw new InvalidConfigError('dimensions must be a positive integer');
    }
    if (config.embedder && config.dimensions !== config.embedder.dimensions) {
      throw new InvalidConfigError(
        `dimensions mismatch: config specifies ${config.dimensions} but embedder provides ${config.embedder.dimensions}`
      );
    }
    dimensions = config.dimensions;
  } else if (config.embedder) {
    dimensions = config.embedder.dimensions;
  } else {
    throw new InvalidConfigError('dimensions is required when no embedder is provided');
  }

  const quantization = config.quantization ?? 'F32';
  const metric = config.metric ?? 'cosine';
  const storageDriver = config.storageDriver ?? nullDriver;

  if (!['F32', 'INT8', 'BIT'].includes(quantization)) {
    throw new InvalidConfigError(`Invalid quantization type: ${quantization}`);
  }

  if (!['cosine', 'euclidean', 'dot', 'hamming'].includes(metric)) {
    throw new InvalidConfigError(`Invalid metric type: ${metric}`);
  }

  if (metric === 'hamming' && quantization !== 'BIT') {
    throw new InvalidConfigError('Hamming metric requires BIT quantization');
  }

  const collectionId = config.collectionId ?? `trovec_${++instanceCounter}`;

  const hasStorage = config.storageDriver != null;
  let autoFlush: false | number;
  if (config.autoFlush === false) {
    autoFlush = false;
  } else if (config.autoFlush === true || config.autoFlush === undefined) {
    autoFlush = hasStorage ? 500 : false;
  } else if (typeof config.autoFlush === 'number') {
    if (config.autoFlush <= 0) {
      throw new InvalidConfigError('autoFlush delay must be a positive number');
    }
    autoFlush = config.autoFlush;
  } else {
    throw new InvalidConfigError('autoFlush must be a boolean or a positive number');
  }

  return {
    dimensions,
    quantization,
    metric,
    storageDriver,
    collectionId,
    autoFlush,
    ...(config.embedder ? { embedder: config.embedder } : {}),
  };
}

export function validateEmbedding(embedding: number[], dimensions: number): void {
  if (embedding.length !== dimensions) {
    throw new DimensionMismatchError(dimensions, embedding.length);
  }

  for (let i = 0; i < embedding.length; i++) {
    if (!Number.isFinite(embedding[i])) {
      throw new InvalidConfigError(`Embedding value at index ${i} is not a finite number`);
    }
  }
}

export function validateEntry(entry: Entry, dimensions: number): void {
  if (entry.id === undefined || entry.id === null) {
    throw new InvalidConfigError('Entry must have an id');
  }

  if (typeof entry.id !== 'string' && typeof entry.id !== 'bigint') {
    throw new InvalidConfigError('Entry id must be a string or bigint');
  }

  if (!Array.isArray(entry.embedding)) {
    throw new InvalidConfigError('Entry must have an embedding array');
  }

  validateEmbedding(entry.embedding, dimensions);
}

export function validateEntries(entries: Entry[], dimensions: number): void {
  for (let i = 0; i < entries.length; i++) {
    try {
      validateEntry(entries[i], dimensions);
    } catch (e) {
      if (e instanceof Error) {
        throw new InvalidConfigError(`Entry at index ${i}: ${e.message}`);
      }
      throw e;
    }
  }
}

export function serializeId(id: EntryId): string {
  if (typeof id === 'bigint') {
    return BIGINT_PREFIX + id.toString();
  }
  return id;
}

export function deserializeId(key: string): EntryId {
  if (key.startsWith(BIGINT_PREFIX)) {
    return BigInt(key.slice(BIGINT_PREFIX.length));
  }
  return key;
}

export function compareIds(a: EntryId, b: EntryId): number {
  const aIsString = typeof a === 'string';
  const bIsString = typeof b === 'string';

  if (aIsString && bIsString) {
    return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
  }

  if (!aIsString && !bIsString) {
    const aBig = a as bigint;
    const bBig = b as bigint;
    return aBig < bBig ? -1 : aBig > bBig ? 1 : 0;
  }

  // Strings sort before bigints
  return aIsString ? -1 : 1;
}
