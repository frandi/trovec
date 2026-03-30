import OpenAI from 'openai';
import type { SearchResult } from './search.js';

export interface Citation {
  index: number;
  pageNumber: number;
  sourceFile: string;
  preview: string;
}

export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AnswerResult {
  answer: string;
  citations: Citation[];
  usage: LlmUsage;
}

const SYSTEM_PROMPT = `You are a helpful assistant that answers questions strictly based on provided document excerpts.

Rules:
- Answer ONLY using information explicitly stated in the provided sources. Do NOT use outside knowledge, assumptions, or inferences beyond what the sources say.
- Every factual claim in your answer MUST have an inline citation like [1], [2], etc. referencing the source number it came from. Do not make uncited claims.
- Only cite source numbers that actually exist in the provided sources. Never fabricate citation numbers.
- If multiple sources support the same point, cite all of them, e.g. [1][3].
- If the sources do not contain enough information to answer the question, explicitly state: "The provided sources do not contain sufficient information to answer this question." Do not guess or fill in gaps.
- If the sources only partially answer the question, answer what you can with citations and clearly state what parts cannot be answered from the available sources.
- Be concise and direct. Do not add introductory or concluding filler.
- At the end of your answer, list ONLY the source numbers you actually cited in a line like: "Sources used: [1], [3], [5]"`;

function buildUserPrompt(question: string, sources: SearchResult[]): string {
  const context = sources
    .map((s, i) => `[${i + 1}] (Page ${s.pageNumber}, ${s.sourceFile})\n${s.fullText}`)
    .join('\n\n');

  return `Sources:\n${context}\n\nQuestion: ${question}`;
}

export async function generateAnswer(
  apiKey: string,
  question: string,
  sources: SearchResult[],
): Promise<AnswerResult> {
  const client = new OpenAI({ apiKey });

  const response = await client.responses.create({
    model: 'gpt-5.4-mini',
    instructions: SYSTEM_PROMPT,
    input: buildUserPrompt(question, sources),
    temperature: 0.3,
  });

  const answer = response.output_text ?? 'No answer generated.';

  // Only include citations that the LLM actually referenced in its answer
  const citedIndices = new Set<number>();
  const citePattern = /\[(\d+)\]/g;
  let match;
  while ((match = citePattern.exec(answer)) !== null) {
    citedIndices.add(parseInt(match[1], 10));
  }

  const citations: Citation[] = sources
    .map((s, i) => ({
      index: i + 1,
      pageNumber: s.pageNumber,
      sourceFile: s.sourceFile,
      preview: s.preview,
    }))
    .filter((c) => citedIndices.has(c.index));

  const usage: LlmUsage = {
    model: response.model,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };

  return { answer, citations, usage };
}
