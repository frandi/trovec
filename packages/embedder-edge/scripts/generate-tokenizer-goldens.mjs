#!/usr/bin/env node
// One-off fixture generator for tests/fixtures/tokenizer-golden.json.
//
// Loads the bge-small tokenizer via @huggingface/transformers and writes
// reference token-ID outputs for a curated set of inputs. The generated
// fixture is committed; the @huggingface/transformers dev dependency can be
// removed once goldens are stable.
//
// Run with:  node scripts/generate-tokenizer-goldens.mjs

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AutoTokenizer } from '@huggingface/transformers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const MODEL_DIR = join(ROOT, 'models', 'bge-small-en-v1.5');
const FIXTURE_PATH = join(ROOT, 'tests', 'fixtures', 'tokenizer-golden.json');

const INPUTS = [
  '',
  'hello',
  'Hello, World!',
  'The quick brown fox jumps over the lazy dog.',
  'embeddings are vectors',
  'snowflake snowflakes snowflaking',
  'résumé café naïve',
  'BAAI/bge-small-en-v1.5 is a model',
  'this-is-a-hyphenated-token',
  'multi  spaces\tand\nnewlines',
  '中文 测试 mixed with english',
  'antidisestablishmentarianismantidisestablishmentarianismantidisestablishmentarianismantidisestablishmentarianism',
  'punctuation: dots... commas, semicolons; question? exclamation!',
  '   leading and trailing   ',
  'GPT-4 OpenAI Anthropic Claude',
];

const MAX_LENGTH = 32;

async function main() {
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_DIR, { local_files_only: true });

  const cases = [];
  for (const input of INPUTS) {
    const encoded = tokenizer(input, {
      add_special_tokens: true,
      truncation: true,
      max_length: MAX_LENGTH,
      padding: false,
    });
    const inputIds = Array.from(encoded.input_ids.data, (x) => Number(x));
    cases.push({ input, maxLength: MAX_LENGTH, inputIds });
  }

  const fixture = {
    note: 'Reference token IDs from @huggingface/transformers AutoTokenizer for bge-small-en-v1.5. Regenerate via scripts/generate-tokenizer-goldens.mjs.',
    modelDir: 'models/bge-small-en-v1.5',
    cases,
  };
  await mkdir(dirname(FIXTURE_PATH), { recursive: true });
  await writeFile(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`Wrote ${cases.length} cases to ${FIXTURE_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
