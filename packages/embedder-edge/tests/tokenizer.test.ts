import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createTokenizer, type TokenizerJson } from '../src/runtime/tokenizer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TOKENIZER_PATH = join(ROOT, 'models', 'bge-small-en-v1.5', 'tokenizer.json');
const GOLDENS_PATH = join(ROOT, 'tests', 'fixtures', 'tokenizer-golden.json');

interface GoldenFixture {
  cases: Array<{ input: string; maxLength: number; inputIds: number[] }>;
}

async function loadFixtures() {
  const [tokenizerRaw, goldensRaw] = await Promise.all([
    readFile(TOKENIZER_PATH, 'utf-8'),
    readFile(GOLDENS_PATH, 'utf-8'),
  ]);
  const spec = JSON.parse(tokenizerRaw) as TokenizerJson;
  const goldens = JSON.parse(goldensRaw) as GoldenFixture;
  return { tokenizer: createTokenizer(spec), goldens };
}

describe('tokenizer goldens', () => {
  it('matches the reference HuggingFace tokenizer for every fixture case', async () => {
    const { tokenizer, goldens } = await loadFixtures();
    for (const c of goldens.cases) {
      const ids = tokenizer.encode(c.input, { maxLength: c.maxLength });
      expect(ids, `mismatch for input ${JSON.stringify(c.input)}`).toEqual(c.inputIds);
    }
  });
});

describe('tokenizer behavior', () => {
  it('always wraps single-sequence output with [CLS] and [SEP]', async () => {
    const { tokenizer } = await loadFixtures();
    const ids = tokenizer.encode('hello', { maxLength: 16 });
    expect(ids[0]).toBe(101); // [CLS]
    expect(ids.at(-1)).toBe(102); // [SEP]
  });

  it('returns just [CLS][SEP] for empty input', async () => {
    const { tokenizer } = await loadFixtures();
    expect(tokenizer.encode('', { maxLength: 16 })).toEqual([101, 102]);
  });

  it('truncates inner tokens but never drops [CLS] or [SEP]', async () => {
    const { tokenizer } = await loadFixtures();
    const long = 'word '.repeat(50).trim();
    const ids = tokenizer.encode(long, { maxLength: 8 });
    expect(ids).toHaveLength(8);
    expect(ids[0]).toBe(101);
    expect(ids.at(-1)).toBe(102);
  });

  it('throws when maxLength is too small for special tokens', async () => {
    const { tokenizer } = await loadFixtures();
    expect(() => tokenizer.encode('hi', { maxLength: 1 })).toThrow(/maxLength/);
  });

  it('lowercases uppercase input (BertNormalizer)', async () => {
    const { tokenizer } = await loadFixtures();
    const lower = tokenizer.encode('hello world', { maxLength: 16 });
    const upper = tokenizer.encode('HELLO WORLD', { maxLength: 16 });
    expect(upper).toEqual(lower);
  });

  it('strips accents (when lowercase=true and strip_accents=null)', async () => {
    const { tokenizer } = await loadFixtures();
    const accented = tokenizer.encode('café', { maxLength: 16 });
    const plain = tokenizer.encode('cafe', { maxLength: 16 });
    expect(accented).toEqual(plain);
  });

  it('isolates punctuation as separate tokens', async () => {
    const { tokenizer } = await loadFixtures();
    const a = tokenizer.encode('hello,world', { maxLength: 16 });
    const b = tokenizer.encode('hello , world', { maxLength: 16 });
    expect(a).toEqual(b);
  });

  it('returns [UNK] for words longer than max_input_chars_per_word', async () => {
    const { tokenizer } = await loadFixtures();
    const long = 'a'.repeat(200);
    const ids = tokenizer.encode(long, { maxLength: 16 });
    expect(ids.slice(1, -1)).toEqual([100]); // [UNK] is id 100
  });
});

describe('encodeBatch', () => {
  it('returns empty arrays for an empty batch', async () => {
    const { tokenizer } = await loadFixtures();
    const batch = tokenizer.encodeBatch([], { maxLength: 16 });
    expect(batch.batchSize).toBe(0);
    expect(batch.length).toBe(0);
    expect(batch.inputIds).toHaveLength(0);
  });

  it('pads all rows to the longest sequence length', async () => {
    const { tokenizer } = await loadFixtures();
    const batch = tokenizer.encodeBatch(['a', 'hello world'], { maxLength: 16 });
    expect(batch.batchSize).toBe(2);
    expect(batch.inputIds).toHaveLength(batch.length * 2);
    // Row 0 padded: last position has pad id (0) and attention 0.
    const lastIdxRow0 = batch.length - 1;
    expect(batch.attentionMask[lastIdxRow0]).toBe(0n);
    expect(batch.inputIds[lastIdxRow0]).toBe(0n);
    // Row 1: last position is [SEP], attention 1.
    const lastIdxRow1 = 2 * batch.length - 1;
    expect(batch.attentionMask[lastIdxRow1]).toBe(1n);
    expect(batch.inputIds[lastIdxRow1]).toBe(102n);
  });

  it('produces token_type_ids of all 0 for single-sequence inputs', async () => {
    const { tokenizer } = await loadFixtures();
    const batch = tokenizer.encodeBatch(['hello', 'world'], { maxLength: 16 });
    for (const v of batch.tokenTypeIds) {
      expect(v).toBe(0n);
    }
  });

  it('matches single-input encode for each row', async () => {
    const { tokenizer } = await loadFixtures();
    const inputs = ['alpha beta', 'gamma'];
    const batch = tokenizer.encodeBatch(inputs, { maxLength: 16 });
    for (let r = 0; r < inputs.length; r++) {
      const single = tokenizer.encode(inputs[r], { maxLength: 16 });
      const slice = Array.from(
        batch.inputIds.slice(r * batch.length, r * batch.length + single.length),
      ).map((x) => Number(x));
      expect(slice).toEqual(single);
    }
  });
});
