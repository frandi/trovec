import type { TrovecConfig, TrovecInstance, TrovecStats, Trovec } from './types.js';
import { validateConfig } from './validation.js';
import { getCodec } from './quantization/index.js';
import { getMetric } from './similarity/index.js';
import { serialize, deserialize } from './serialization.js';
import { wrapInstance } from './fluent.js';

export async function create(config: TrovecConfig): Promise<Trovec> {
  const resolved = validateConfig(config);

  const codec = getCodec(resolved.quantization);
  const similarityFn = getMetric(resolved.metric);

  const instance: TrovecInstance = {
    config: Object.freeze(resolved),
    entries: new Map(),
    codec,
    similarityFn,
    dirty: false,
    collectionId: resolved.collectionId,
  };

  // Auto-load existing data from storage driver
  const buffer = await resolved.storageDriver.read(resolved.collectionId);
  if (buffer) {
    deserialize(buffer, instance);
  }

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
