// Pure-TS BERT WordPiece tokenizer for edge embedders.
//
// Implements the subset of HuggingFace `tokenizer.json` behavior needed for
// bge-small-en-v1.5 and other lowercase BERT-WordPiece models:
//
//   normalizer    BertNormalizer (clean_text, lowercase, strip_accents, CJK)
//   pre_tokenizer BertPreTokenizer (whitespace + isolate punctuation)
//   model         WordPiece (greedy longest-match, ## continuing prefix)
//   post_proc     TemplateProcessing for single sequences ([CLS] ... [SEP])
//
// Out of scope: pair sequences, byte-level / SentencePiece models, custom
// templates, BPE.

import { readFile } from 'node:fs/promises';

export interface TokenizerJson {
  added_tokens?: AddedToken[];
  normalizer?: NormalizerSpec;
  pre_tokenizer?: PreTokenizerSpec;
  post_processor?: PostProcessorSpec;
  model: WordPieceModelSpec;
}

interface AddedToken {
  id: number;
  content: string;
  special: boolean;
}

interface NormalizerSpec {
  type: string;
  clean_text?: boolean;
  handle_chinese_chars?: boolean;
  strip_accents?: boolean | null;
  lowercase?: boolean;
}

interface PreTokenizerSpec {
  type: string;
}

interface PostProcessorSpec {
  type: string;
  single?: TemplateItem[];
  special_tokens?: Record<string, { id: string; ids: number[] }>;
}

type TemplateItem =
  | { SpecialToken: { id: string; type_id: number } }
  | { Sequence: { id: string; type_id: number } };

interface WordPieceModelSpec {
  type: string;
  unk_token: string;
  continuing_subword_prefix: string;
  max_input_chars_per_word: number;
  vocab: Record<string, number>;
}

export interface EncodeOptions {
  /** Maximum tokens (including special tokens). Longer inputs are truncated. */
  maxLength: number;
}

export interface EncodedBatch {
  /** Input IDs, flattened row-major. Shape [batch, length]. */
  inputIds: BigInt64Array;
  /** Attention mask, flattened. 1 = real token, 0 = padding. */
  attentionMask: BigInt64Array;
  /** Token type IDs, flattened. All 0 for single-sequence inputs. */
  tokenTypeIds: BigInt64Array;
  /** Number of inputs in the batch. */
  batchSize: number;
  /** Per-row sequence length after padding (uniform across the batch). */
  length: number;
}

export interface Tokenizer {
  encode(text: string, options: EncodeOptions): number[];
  encodeBatch(texts: string[], options: EncodeOptions): EncodedBatch;
  /** Underlying spec — exposed for tests and debugging. */
  readonly spec: TokenizerJson;
}

const PUNCT_REGEX = /[!-/:-@[-`{-~¡-¿ -⁯　-〿＀-￯]/;
const COMBINING_MARK_REGEX = /\p{M}/gu;

function isWhitespace(ch: string): boolean {
  if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') return true;
  return /\s/.test(ch);
}

function isControl(ch: string): boolean {
  if (ch === '\t' || ch === '\n' || ch === '\r') return false;
  const code = ch.codePointAt(0)!;
  // Cc + Cf, but allow tab/newline/cr handled above.
  return (code >= 0x0000 && code <= 0x001f) || (code >= 0x007f && code <= 0x009f);
}

function isPunctuation(ch: string): boolean {
  return PUNCT_REGEX.test(ch);
}

function isChineseChar(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x2a6df) ||
    (code >= 0x2a700 && code <= 0x2b73f) ||
    (code >= 0x2b740 && code <= 0x2b81f) ||
    (code >= 0x2b820 && code <= 0x2ceaf) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x2f800 && code <= 0x2fa1f)
  );
}

function cleanText(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    if (code === 0 || code === 0xfffd || isControl(ch)) continue;
    out += isWhitespace(ch) ? ' ' : ch;
  }
  return out;
}

function padCjkSpaces(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    if (isChineseChar(code)) {
      out += ` ${ch} `;
    } else {
      out += ch;
    }
  }
  return out;
}

function stripAccents(input: string): string {
  return input.normalize('NFD').replace(COMBINING_MARK_REGEX, '');
}

function applyNormalizer(text: string, spec: NormalizerSpec | undefined): string {
  if (!spec || spec.type !== 'BertNormalizer') return text;
  let s = text;
  if (spec.clean_text) s = cleanText(s);
  if (spec.handle_chinese_chars) s = padCjkSpaces(s);
  if (spec.lowercase) s = s.toLowerCase();
  // strip_accents: null means "follow lowercase". true forces it; false forces off.
  const strip = spec.strip_accents == null ? !!spec.lowercase : spec.strip_accents;
  if (strip) s = stripAccents(s);
  return s;
}

/**
 * BertPreTokenizer: split on whitespace, then isolate each punctuation
 * character as its own token.
 */
function bertPreTokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const piece of text.split(/\s+/)) {
    if (!piece) continue;
    let buf = '';
    for (const ch of piece) {
      if (isPunctuation(ch)) {
        if (buf) {
          tokens.push(buf);
          buf = '';
        }
        tokens.push(ch);
      } else {
        buf += ch;
      }
    }
    if (buf) tokens.push(buf);
  }
  return tokens;
}

function wordPieceTokenize(
  word: string,
  vocab: Map<string, number>,
  unkId: number,
  prefix: string,
  maxChars: number,
): number[] {
  if (word.length > maxChars) return [unkId];
  const ids: number[] = [];
  let start = 0;
  const end = word.length;
  while (start < end) {
    let stop = end;
    let curId: number | undefined;
    while (stop > start) {
      const sub = (start === 0 ? '' : prefix) + word.slice(start, stop);
      const id = vocab.get(sub);
      if (id !== undefined) {
        curId = id;
        break;
      }
      stop--;
    }
    if (curId === undefined) {
      // No subword matched anywhere from this start — entire word is UNK.
      return [unkId];
    }
    ids.push(curId);
    start = stop;
  }
  return ids;
}

interface SpecialTokenIds {
  cls: number;
  sep: number;
  pad: number;
}

function resolveSpecialIds(spec: TokenizerJson): SpecialTokenIds {
  const added = new Map<string, number>();
  for (const t of spec.added_tokens ?? []) {
    if (t.special) added.set(t.content, t.id);
  }
  const get = (name: string): number => {
    const id = added.get(name);
    if (id === undefined) {
      throw new Error(`Tokenizer is missing required special token "${name}"`);
    }
    return id;
  };
  return { cls: get('[CLS]'), sep: get('[SEP]'), pad: get('[PAD]') };
}

/**
 * Construct a tokenizer from the parsed contents of a HuggingFace
 * `tokenizer.json` file.
 */
export function createTokenizer(spec: TokenizerJson): Tokenizer {
  if (spec.model.type !== 'WordPiece') {
    throw new Error(`Unsupported tokenizer model type: ${spec.model.type}`);
  }
  const vocab = new Map<string, number>(Object.entries(spec.model.vocab));
  const unkLookup = vocab.get(spec.model.unk_token);
  if (unkLookup === undefined) {
    throw new Error(`Tokenizer vocab is missing unk_token "${spec.model.unk_token}"`);
  }
  const unkId: number = unkLookup;
  const special = resolveSpecialIds(spec);
  const prefix = spec.model.continuing_subword_prefix;
  const maxChars = spec.model.max_input_chars_per_word;

  function encodeRaw(text: string): number[] {
    const normalized = applyNormalizer(text, spec.normalizer);
    const words = bertPreTokenize(normalized);
    const ids: number[] = [];
    for (const word of words) {
      const sub = wordPieceTokenize(word, vocab, unkId, prefix, maxChars);
      ids.push(...sub);
    }
    return ids;
  }

  function encode(text: string, { maxLength }: EncodeOptions): number[] {
    if (maxLength < 2) {
      throw new Error('maxLength must be at least 2 to fit [CLS] and [SEP]');
    }
    const inner = encodeRaw(text).slice(0, maxLength - 2);
    return [special.cls, ...inner, special.sep];
  }

  function encodeBatch(texts: string[], { maxLength }: EncodeOptions): EncodedBatch {
    if (texts.length === 0) {
      return {
        inputIds: new BigInt64Array(0),
        attentionMask: new BigInt64Array(0),
        tokenTypeIds: new BigInt64Array(0),
        batchSize: 0,
        length: 0,
      };
    }
    const rows = texts.map((t) => encode(t, { maxLength }));
    const length = Math.max(...rows.map((r) => r.length));
    const total = texts.length * length;
    const inputIds = new BigInt64Array(total);
    const attentionMask = new BigInt64Array(total);
    const tokenTypeIds = new BigInt64Array(total);
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const off = r * length;
      for (let i = 0; i < length; i++) {
        if (i < row.length) {
          inputIds[off + i] = BigInt(row[i]);
          attentionMask[off + i] = 1n;
        } else {
          inputIds[off + i] = BigInt(special.pad);
          // attentionMask and tokenTypeIds default to 0n
        }
      }
    }
    return { inputIds, attentionMask, tokenTypeIds, batchSize: texts.length, length };
  }

  return { encode, encodeBatch, spec };
}

/** Convenience loader: read a `tokenizer.json` from disk. */
export async function loadTokenizer(path: string): Promise<Tokenizer> {
  const raw = await readFile(path, 'utf-8');
  const spec = JSON.parse(raw) as TokenizerJson;
  return createTokenizer(spec);
}
