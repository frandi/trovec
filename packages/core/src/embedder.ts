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

export async function embed(instance: TrovecInstance, input: string): Promise<EmbedResult> {
  return getEmbedder(instance).embed(input);
}

export async function embedMany(instance: TrovecInstance, input: string[]): Promise<EmbedResult[]> {
  return getEmbedder(instance).embedMany(input);
}

export async function addWithText(instance: TrovecInstance, entry: TextEntry): Promise<void> {
  const embedder = getEmbedder(instance);
  const { embedding } = await embedder.embed(entry.text);
  add(instance, { id: entry.id, embedding, context: entry.context });
}

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
