import type { TrovecInstance } from '@trovec/core';
import { queryByText } from '@trovec/core';

export interface SearchResult {
  id: string;
  score: number;
  pageNumber: number;
  sourceFile: string;
  fullText: string;
  preview: string;
}

export async function searchDocuments(
  db: TrovecInstance,
  query: string,
  topK: number = 5,
): Promise<SearchResult[]> {
  const results = await queryByText(db, { text: 'search_query: ' + query, topK });

  return results.map((r) => ({
    id: String(r.id),
    score: r.score,
    pageNumber: (r.context?.pageNumber as number) ?? 0,
    sourceFile: (r.context?.sourceFile as string) ?? 'unknown',
    fullText: (r.context?.fullText as string) ?? '',
    preview: (r.context?.preview as string) ?? '',
  }));
}
