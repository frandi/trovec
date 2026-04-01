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
} from './types.js';

export { create, flush, close, stats } from './core.js';

export { add, addMany, get, del as delete } from './collection.js';

export { query } from './query.js';

export { embed, embedMany, addWithText, addManyWithText, queryByText } from './embedder.js';

export { createMemoryDriver } from './storage/memory.js';

export { createFileDriver } from './storage/file.js';

export { serialize, deserialize } from './serialization.js';
