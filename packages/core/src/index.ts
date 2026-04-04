export type {
  Entry,
  EntryId,
  QueryResult,
  QueryParams,
  TrovecConfig,
  TrovecStats,
  TrovecInstance,
  Trovec,
  StorageDriver,
  FileStorageDriver,
  FileDriverOptions,
  QuantizationType,
  MetricType,
  Embedder,
  EmbedResult,
  ResolvedTrovecConfig,
  TextEntry,
  TextQueryParams,
  ConcurrentFileDriverOptions,
  ConcurrentFileStorageDriver,
  WalOperation,
  WalAwareDriver,
  EncryptionOptions,
} from './types.js';

export { isWalAwareDriver } from './types.js';

export { TrovecError, DimensionMismatchError, InvalidConfigError, LockTimeoutError, WalCorruptionError, EncryptionError } from './errors.js';

export { create, flush, close, stats } from './core.js';

export { add, addMany, get, del as delete } from './collection.js';

export { query } from './query.js';

export { embed, embedMany, addWithText, addManyWithText, queryByText } from './embedder.js';

export { createMemoryDriver } from './storage/memory.js';

export { createFileDriver } from './storage/file.js';

export { createConcurrentFileDriver } from './storage/concurrent-file.js';

export { withEncryption } from './storage/encryption.js';

export { serialize, deserialize } from './serialization.js';
