// === Public types ===

export type EntryId = string | bigint;

export interface Entry {
  id: EntryId;
  embedding: number[];
  context?: Record<string, unknown>;
}

export interface QueryResult {
  id: EntryId;
  score: number;
  context?: Record<string, unknown>;
}

export type QuantizationType = 'F32' | 'INT8' | 'BIT';

export type MetricType = 'cosine' | 'euclidean' | 'dot' | 'hamming';

export interface QueryParams {
  vector: number[];
  topK?: number;
  filter?: (context: Record<string, unknown> | undefined) => boolean;
}

export interface EmbedResult {
  embedding: number[];
}

export interface Embedder {
  embed(input: string): Promise<EmbedResult>;
  embedMany(input: string[]): Promise<EmbedResult[]>;
}

export interface TrovecConfig {
  dimensions: number;
  quantization?: QuantizationType;
  metric?: MetricType;
  storageDriver?: StorageDriver;
  embedder?: Embedder;
  collectionId?: string;
  autoFlush?: boolean | number;
}

export interface TrovecStats {
  entryCount: number;
  dimensions: number;
  quantization: QuantizationType;
  metric: MetricType;
  indexStatus: 'brute-force';
}

export interface StorageDriver {
  write(collectionId: string, data: Buffer): Promise<void>;
  read(collectionId: string): Promise<Buffer | null>;
  exists(collectionId: string): Promise<boolean>;
  delete(collectionId: string): Promise<boolean>;
}

export interface FileDriverOptions {
  directory?: string;
  compression?: boolean;
  compressionLevel?: number;
}

export interface FileStorageDriver extends StorageDriver {
  readonly directory: string;
  destroy(): Promise<void>;
}

// === Internal types ===

export interface QuantizedVector {
  data: Float64Array | Int8Array | Buffer;
  min?: number;
  max?: number;
  dimensions?: number;
}

export interface StoredEntry {
  id: EntryId;
  quantized: QuantizedVector;
  context?: Record<string, unknown>;
}

export interface QuantizationCodec {
  type: QuantizationType;
  encode(embedding: number[]): QuantizedVector;
  decode(quantized: QuantizedVector): number[];
}

export type SimilarityFn = (a: QuantizedVector, b: QuantizedVector) => number;

export interface ResolvedTrovecConfig {
  dimensions: number;
  quantization: QuantizationType;
  metric: MetricType;
  storageDriver: StorageDriver;
  embedder?: Embedder;
  collectionId: string;
  autoFlush: false | number;
}

export interface TrovecInstance {
  readonly config: Readonly<ResolvedTrovecConfig>;
  entries: Map<string, StoredEntry>;
  codec: QuantizationCodec;
  similarityFn: SimilarityFn;
  dirty: boolean;
  collectionId: string;
  _scheduleFlush?: () => void;
  _flushTimer?: ReturnType<typeof setTimeout>;
  _flushing?: Promise<void>;
  _beforeExitHandler?: () => void;
}

// === Text types (used by embedder + fluent API) ===

export interface TextEntry {
  id: EntryId;
  text: string;
  context?: Record<string, unknown>;
}

export interface TextQueryParams {
  text: string;
  topK?: number;
  filter?: (context: Record<string, unknown> | undefined) => boolean;
}

// === Fluent API ===

export interface Trovec extends TrovecInstance {
  // Collection
  add(entry: Entry): void;
  addMany(entries: Entry[]): void;
  get(id: EntryId): Entry | undefined;
  delete(id: EntryId): boolean;

  // Query
  query(params: QueryParams): QueryResult[];

  // Core
  stats(): TrovecStats;
  flush(): Promise<void>;
  close(): Promise<void>;

  // Embedder (requires embedder in config)
  embed(input: string): Promise<EmbedResult>;
  embedMany(input: string[]): Promise<EmbedResult[]>;
  addWithText(entry: TextEntry): Promise<void>;
  addManyWithText(entries: TextEntry[]): Promise<void>;
  queryByText(params: TextQueryParams): Promise<QueryResult[]>;

  // Serialization
  serialize(): Buffer;
  deserialize(buffer: Buffer): void;
}
