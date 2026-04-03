import type { TrovecConfig, TrovecInstance, TrovecStats, Trovec } from './types.js';
import { isWalAwareDriver } from './types.js';
import { validateConfig } from './validation.js';
import { getCodec } from './quantization/index.js';
import { getMetric } from './similarity/index.js';
import { serialize, deserialize } from './serialization.js';
import { wrapInstance } from './fluent.js';

/**
 * Create a new Trovec vector database instance.
 *
 * Validates the configuration, initializes quantization and similarity internals,
 * loads any existing data from the storage driver, and sets up auto-flush if enabled.
 *
 * @param config - Configuration options for this instance.
 * @returns A {@link Trovec} instance with a fluent API.
 * @throws {InvalidConfigError} If the configuration is invalid (e.g. missing dimensions, incompatible metric/quantization).
 *
 * @example
 * ```ts
 * import { create, createFileDriver } from '@trovec/core';
 *
 * const db = await create({
 *   dimensions: 384,
 *   metric: 'cosine',
 *   storageDriver: createFileDriver({ directory: './data' }),
 * });
 * ```
 */
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

  // Initialize WAL buffer if using a WAL-aware storage driver
  if (isWalAwareDriver(resolved.storageDriver)) {
    instance._walBuffer = [];
  }

  // Initialize auto-flush scheduler
  if (resolved.autoFlush !== false) {
    const delayMs = resolved.autoFlush;
    instance._scheduleFlush = () => {
      if (instance._flushTimer != null) {
        clearTimeout(instance._flushTimer);
      }
      instance._flushTimer = setTimeout(() => {
        instance._flushTimer = undefined;
        flush(instance).catch((err) => {
          console.warn('Trovec auto-flush failed:', err);
        });
      }, delayMs);
      // Don't keep the process alive just for auto-flush
      instance._flushTimer.unref();
    };

    // Safety net: flush on graceful shutdown even if close() is never called.
    // When the event loop drains, beforeExit fires and we persist any dirty data.
    // After flush completes (dirty=false), the next beforeExit is a no-op.
    instance._beforeExitHandler = () => {
      if (instance.dirty) {
        flush(instance).catch((err) => {
          console.warn('Trovec beforeExit flush failed:', err);
        });
      }
    };
    process.on('beforeExit', instance._beforeExitHandler);
  }

  return wrapInstance(instance);
}

/**
 * Persist all pending changes to the storage driver immediately.
 *
 * Cancels any pending auto-flush timer and waits for any in-progress flush to complete
 * before starting a new one. No-op if no storage driver is configured.
 *
 * @param instance - The Trovec instance to flush.
 */
export async function flush(instance: TrovecInstance): Promise<void> {
  if (!instance.config.storageDriver) return;

  // Clear pending debounce timer — we're flushing now
  if (instance._flushTimer != null) {
    clearTimeout(instance._flushTimer);
    instance._flushTimer = undefined;
  }

  // Wait for any in-progress flush to complete before starting a new one
  if (instance._flushing) {
    await instance._flushing;
  }

  const doFlush = async () => {
    const driver = instance.config.storageDriver;
    if (isWalAwareDriver(driver) && instance._walBuffer && instance._walBuffer.length > 0) {
      try {
        await driver.appendWal(instance.collectionId, instance._walBuffer);
        instance._walBuffer = [];
      } catch (err: unknown) {
        // If WAL config isn't ready (fresh collection), fall back to full write
        if (err && (err as Error).name === 'WalConfigNotReady') {
          const buffer = serialize(instance);
          await driver.write(instance.collectionId, buffer);
          instance._walBuffer = [];
        } else {
          throw err;
        }
      }
    } else {
      const buffer = serialize(instance);
      await driver.write(instance.collectionId, buffer);
    }
    instance.dirty = false;
  };

  instance._flushing = doFlush();
  try {
    await instance._flushing;
  } finally {
    instance._flushing = undefined;
  }
}

/**
 * Gracefully shut down a Trovec instance.
 *
 * Flushes any unsaved changes, removes the `beforeExit` listener,
 * and disables further auto-flush scheduling. Always call this when you are done
 * with an instance to prevent resource leaks.
 *
 * @param instance - The Trovec instance to close.
 */
export async function close(instance: TrovecInstance): Promise<void> {
  // Clear the debounce timer
  if (instance._flushTimer != null) {
    clearTimeout(instance._flushTimer);
    instance._flushTimer = undefined;
  }

  // Final flush if there are unsaved changes
  if (instance.dirty) {
    await flush(instance);
  }

  // Remove beforeExit handler to prevent memory leaks
  if (instance._beforeExitHandler) {
    process.removeListener('beforeExit', instance._beforeExitHandler);
    instance._beforeExitHandler = undefined;
  }

  // Disable further auto-flush scheduling
  instance._scheduleFlush = undefined;
}

/**
 * Get runtime statistics about the collection.
 *
 * @param instance - The Trovec instance to inspect.
 * @returns A snapshot of entry count, configured dimensions, quantization, metric, and index type.
 */
export function stats(instance: TrovecInstance): TrovecStats {
  return {
    entryCount: instance.entries.size,
    dimensions: instance.config.dimensions,
    quantization: instance.config.quantization,
    metric: instance.config.metric,
    indexStatus: 'brute-force',
  };
}
