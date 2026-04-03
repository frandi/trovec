import type { TrovecInstance, Entry, QueryParams, QueryResult, EmbedResult, TextEntry, TextQueryParams } from './types.js';
import { add, addMany } from './collection.js';
import { query } from './query.js';
import { TrovecError } from './errors.js';

function getEmbedder(instance: TrovecInstance) {
  if (!instance.config.embedder) {
    throw new TrovecError(
      'No embedder configured. Pass an embedder in create() config, ' +
      'e.g. create({ embedder: myEmbedder }). ' +
      'Install an adapter package such as @trovec/embedder-openai or @trovec/embedder-ollama.'
    );
  }
  return instance.config.embedder;
}

/**
 * Generate an embedding for a single text input using the configured {@link Embedder}.
 *
 * @param instance - The Trovec instance (must have an embedder configured).
 * @param input - The text to embed.
 * @returns The generated embedding result.
 * @throws {TrovecError} If no embedder is configured.
 */
export async function embed(instance: TrovecInstance, input: string): Promise<EmbedResult> {
  return getEmbedder(instance).embed(input);
}

/**
 * Generate embeddings for multiple text inputs in a single batch call.
 *
 * @param instance - The Trovec instance (must have an embedder configured).
 * @param input - Array of texts to embed.
 * @returns Array of embedding results, one per input.
 * @throws {TrovecError} If no embedder is configured.
 */
export async function embedMany(instance: TrovecInstance, input: string[]): Promise<EmbedResult[]> {
  return getEmbedder(instance).embedMany(input);
}

/**
 * Embed the entry's text and add the resulting vector to the collection.
 *
 * Convenience wrapper that calls the embedder and then {@link add} in one step.
 *
 * @param instance - The Trovec instance (must have an embedder configured).
 * @param entry - A text entry with an ID, raw text, and optional context.
 * @throws {TrovecError} If no embedder is configured.
 * @throws {DimensionMismatchError} If the generated embedding does not match configured dimensions.
 */
export async function addWithText(instance: TrovecInstance, entry: TextEntry): Promise<void> {
  const embedder = getEmbedder(instance);
  const { embedding } = await embedder.embed(entry.text);
  add(instance, { id: entry.id, embedding, context: entry.context });
}

/**
 * Embed multiple text entries and add them all to the collection in a single batch.
 *
 * Texts are embedded in one batch call to the embedder, then inserted atomically
 * via {@link addMany}.
 *
 * @param instance - The Trovec instance (must have an embedder configured).
 * @param entries - Array of text entries to embed and store.
 * @throws {TrovecError} If no embedder is configured.
 * @throws {DimensionMismatchError} If any generated embedding does not match configured dimensions.
 */
export async function addManyWithText(instance: TrovecInstance, entries: TextEntry[]): Promise<void> {
  const embedder = getEmbedder(instance);
  const texts = entries.map((e) => e.text);
  const results = await embedder.embedMany(texts);

  const fullEntries: Entry[] = entries.map((entry, i) => ({
    id: entry.id,
    embedding: results[i].embedding,
    context: entry.context,
  }));

  addMany(instance, fullEntries);
}

/**
 * Embed the query text and perform a similarity search against all entries.
 *
 * Convenience wrapper that embeds the text and then calls {@link query}.
 *
 * @param instance - The Trovec instance (must have an embedder configured).
 * @param params - Query parameters including the search text, optional topK limit, and optional filter.
 * @returns The top-K most similar entries, sorted by descending score.
 * @throws {TrovecError} If no embedder is configured.
 */
export async function queryByText(instance: TrovecInstance, params: TextQueryParams): Promise<QueryResult[]> {
  const embedder = getEmbedder(instance);
  const { embedding } = await embedder.embed(params.text);

  const queryParams: QueryParams = {
    vector: embedding,
    topK: params.topK,
    filter: params.filter,
  };

  return query(instance, queryParams);
}
