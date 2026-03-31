import type { TrovecConfig, TrovecInstance, TrovecStats, Trovec } from './types.js';
import { validateConfig } from './validation.js';
import { getCodec } from './quantization/index.js';
import { getMetric } from './similarity/index.js';
import { serialize } from './serialization.js';
import { wrapInstance } from './fluent.js';

let instanceCounter = 0;

export function create(config: TrovecConfig): Trovec {
  const resolved = validateConfig(config);

  const codec = getCodec(resolved.quantization);
  const similarityFn = getMetric(resolved.metric);
  const collectionId = `trovec_${++instanceCounter}`;

  const instance: TrovecInstance = {
    config: Object.freeze(resolved),
    entries: new Map(),
    codec,
    similarityFn,
    dirty: false,
    collectionId,
  };

  return wrapInstance(instance);
}

export async function flush(instance: TrovecInstance): Promise<void> {
  if (!instance.config.storageDriver) return;

  const buffer = serialize(instance);
  await instance.config.storageDriver.write(instance.collectionId, buffer);
  instance.dirty = false;
}

export function stats(instance: TrovecInstance): TrovecStats {
  return {
    entryCount: instance.entries.size,
    dimensions: instance.config.dimensions,
    quantization: instance.config.quantization,
    metric: instance.config.metric,
    indexStatus: 'brute-force',
  };
}
