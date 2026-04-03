import type { TrovecInstance, QueryParams, QueryResult } from './types.js';
import { validateEmbedding, compareIds } from './validation.js';

/**
 * Perform a brute-force similarity search against all entries in the collection.
 *
 * The query vector is quantized and compared against every stored entry using the
 * configured similarity metric. Results are sorted by descending score with
 * tie-breaking by entry ID.
 *
 * @param instance - The Trovec instance.
 * @param params - Query parameters including the search vector, optional topK limit, and optional filter.
 * @returns The top-K most similar entries, sorted by descending score.
 * @throws {DimensionMismatchError} If the query vector length does not match configured dimensions.
 */
export function query(instance: TrovecInstance, params: QueryParams): QueryResult[] {
  validateEmbedding(params.vector, instance.config.dimensions);

  const topK = params.topK ?? 10;
  const filter = params.filter;

  // Quantize the query vector
  const quantizedQuery = instance.codec.encode(params.vector);

  const results: QueryResult[] = [];

  for (const [, entry] of instance.entries) {
    if (filter && !filter(entry.context)) continue;

    const score = instance.similarityFn(quantizedQuery, entry.quantized);

    results.push({
      id: entry.id,
      score,
      context: entry.context,
    });
  }

  // Sort descending by score, tie-break by lower ID first
  results.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (scoreDiff !== 0) return scoreDiff;
    return compareIds(a.id, b.id);
  });

  return results.slice(0, topK);
}
