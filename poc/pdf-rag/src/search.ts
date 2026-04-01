import type { Trovec } from '@trovec/core';

export interface SearchResult {
  id: string;
  score: number;
  pageNumber: number;
  sourceFile: string;
  fullText: string;
  preview: string;
}

export async function searchDocuments(
  db: Trovec,
  query: string,
  topK: number = 5,
): Promise<SearchResult[]> {
  const results = await db.queryByText({ text: query, topK });

  return results.map((r) => ({
    id: String(r.id),
    score: r.score,
    pageNumber: (r.context?.pageNumber as number) ?? 0,
    sourceFile: (r.context?.sourceFile as string) ?? 'unknown',
    fullText: (r.context?.fullText as string) ?? '',
    preview: (r.context?.preview as string) ?? '',
  }));
}
