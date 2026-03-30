#!/usr/bin/env npx tsx

/**
 * Ollama Quality Benchmark (LLM-as-Judge)
 *
 * Compares output quality of LLM models across 4 task categories using a
 * judge LLM to evaluate responses. Automated checks are only used for
 * objectively verifiable criteria (JSON validity, tool call structure).
 *
 * Usage:
 *   npx tsx scripts/benchmark-ollama-quality.ts
 *
 * Environment:
 *   OLLAMA_HOST   — Ollama base URL (default: http://localhost:11434)
 *   LLM_MODELS    — Comma-separated models to benchmark (default: llama3.2:1b,llama3.2:3b)
 *   JUDGE_MODEL   — Model used as judge (default: llama3.2:3b)
 *   TEMPERATURE   — Sampling temperature for test subjects (default: 0.1)
 *   NUM_PREDICT   — Max tokens for test subjects (default: 512)
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const LLM_MODELS = (process.env.LLM_MODELS ?? 'llama3.2:1b,llama3.2:3b').split(',').map(s => s.trim());
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? 'llama3.2:3b';
const TEMPERATURE = Number(process.env.TEMPERATURE ?? 0.1);
const NUM_PREDICT = Number(process.env.NUM_PREDICT ?? 512);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string; enum?: string[] }>;
      required: string[];
    };
  };
}

interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

interface Criterion {
  name: string;
  description: string;
}

interface AutoCheck {
  name: string;
  fn: (response: string, toolCalls?: ToolCall[]) => boolean;
}

interface TestCase {
  id: string;
  category: string;
  name: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  criteria: Criterion[];
  autoChecks?: AutoCheck[];
}

interface CheckResult {
  name: string;
  passed: boolean;
  reason: string;
  source: 'judge' | 'auto';
}

interface TestResult {
  testCase: TestCase;
  model: string;
  response: string;
  toolCalls?: ToolCall[];
  checkResults: CheckResult[];
  passCount: number;
  totalChecks: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Ollama Chat API
// ---------------------------------------------------------------------------

async function ollamaChat(
  model: string,
  messages: ChatMessage[],
  opts: { tools?: ToolDefinition[]; temperature?: number; numPredict?: number } = {},
): Promise<{ content: string; toolCalls?: ToolCall[]; durationMs: number }> {
  const start = performance.now();
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      tools: opts.tools,
      options: {
        num_predict: opts.numPredict ?? NUM_PREDICT,
        temperature: opts.temperature ?? TEMPERATURE,
      },
    }),
  });

  if (!res.ok) throw new Error(`Ollama chat failed: ${res.status}`);
  const data = await res.json();

  return {
    content: data.message?.content ?? '',
    toolCalls: data.message?.tool_calls,
    durationMs: performance.now() - start,
  };
}

// ---------------------------------------------------------------------------
// LLM Judge
// ---------------------------------------------------------------------------

interface JudgeVerdict {
  criterion: string;
  pass: boolean;
  reason: string;
}

async function judgeResponse(
  task: string,
  originalPrompt: string,
  response: string,
  criteria: Criterion[],
  toolCallsStr?: string,
): Promise<JudgeVerdict[]> {
  const criteriaList = criteria.map((c, i) => `  criterion_${i + 1}: "${c.name}" - ${c.description}`).join('\n');

  const responseSection = toolCallsStr
    ? `Response text: "${response}"\nTool calls: ${toolCallsStr}`
    : `Response: "${response}"`;

  // Use structured JSON output for reliable parsing
  const judgePrompt = `Evaluate an AI response against specific criteria.

TASK: ${task}

USER PROMPT: "${originalPrompt}"

ASSISTANT RESPONSE:
${responseSection}

CRITERIA TO EVALUATE:
${criteriaList}

Judge the quality and intent, not just exact keywords. Be fair but strict.

Respond with ONLY a JSON array. Each element must have "name" (criterion name), "pass" (true or false), and "reason" (brief explanation). Example:
[{"name":"Example criterion","pass":true,"reason":"Meets the requirement"}]

Output the JSON array now:`;

  const result = await ollamaChat(JUDGE_MODEL, [
    { role: 'system', content: 'You are a strict but fair evaluator. Output ONLY valid JSON. No markdown, no explanation, just the JSON array.' },
    { role: 'user', content: judgePrompt },
  ], { temperature: 0.1, numPredict: 1024 });

  // Parse JSON from judge response
  const verdicts: JudgeVerdict[] = [];
  let parsed: Array<{ name: string; pass: boolean; reason: string }> | null = null;

  // Try multiple extraction strategies
  const raw = result.content.trim();

  // Strategy 1: direct JSON parse
  try { parsed = JSON.parse(raw); } catch { /* continue */ }

  // Strategy 2: extract from markdown code block
  if (!parsed) {
    const codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) {
      try { parsed = JSON.parse(codeBlock[1].trim()); } catch { /* continue */ }
    }
  }

  // Strategy 3: find JSON array in the text
  if (!parsed) {
    const arrMatch = raw.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try { parsed = JSON.parse(arrMatch[0]); } catch { /* continue */ }
    }
  }

  if (Array.isArray(parsed)) {
    // Map parsed results back to criteria
    for (const criterion of criteria) {
      const match = parsed.find((p: any) =>
        typeof p.name === 'string' &&
        p.name.toLowerCase().includes(criterion.name.toLowerCase())
      );
      if (match) {
        verdicts.push({
          criterion: criterion.name,
          pass: !!match.pass,
          reason: match.reason ?? 'No reason',
        });
      } else {
        // Try positional matching if name matching fails
        const idx = criteria.indexOf(criterion);
        const positional = parsed[idx];
        if (positional && typeof positional.pass === 'boolean') {
          verdicts.push({
            criterion: criterion.name,
            pass: positional.pass,
            reason: positional.reason ?? 'Matched by position',
          });
        } else {
          verdicts.push({
            criterion: criterion.name,
            pass: false,
            reason: 'Judge output could not be matched to this criterion',
          });
        }
      }
    }
  } else {
    // Fallback: line-by-line parsing for non-JSON output
    const lines = raw.split('\n').filter(l => l.trim().length > 0);
    for (const criterion of criteria) {
      const matchLine = lines.find(l => l.toLowerCase().includes(criterion.name.toLowerCase()));
      if (matchLine) {
        // Check for PASS/FAIL/yes/no/true/false patterns
        const lower = matchLine.toLowerCase();
        const passed = /\bpass\b|\btrue\b|\byes\b/.test(lower) && !/\bfail\b|\bfalse\b|\bno\b/.test(lower);
        const reason = matchLine.replace(/^.*?(REASON|reason)\s*[:=]\s*/i, '').slice(0, 100) || matchLine.slice(0, 100);
        verdicts.push({ criterion: criterion.name, pass: passed, reason });
      } else {
        verdicts.push({ criterion: criterion.name, pass: false, reason: 'Judge did not evaluate this criterion' });
      }
    }
  }

  return verdicts;
}

// ---------------------------------------------------------------------------
// Auto-check helpers (for objectively verifiable things only)
// ---------------------------------------------------------------------------

function isValidJson(text: string): boolean {
  try { JSON.parse(text.trim()); return true; } catch { /* continue */ }
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) {
    try { JSON.parse(match[1].trim()); return true; } catch { /* continue */ }
  }
  return false;
}

function extractJson(text: string): Record<string, unknown> | null {
  try { return JSON.parse(text.trim()); } catch { /* continue */ }
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) {
    try { return JSON.parse(match[1].trim()); } catch { /* continue */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

const TEST_CASES: TestCase[] = [
  // ── Following Instructions ───────────────────────────────────────────────
  {
    id: 'instr-1',
    category: 'Following Instructions',
    name: 'Exactly 3 bullet points',
    messages: [
      { role: 'system', content: 'You are a helpful assistant. Always follow the user\'s formatting instructions exactly.' },
      { role: 'user', content: 'List the benefits of drinking water. Respond in exactly 3 bullet points. Use a dash (-) for each bullet point.' },
    ],
    criteria: [
      { name: 'Correct count', description: 'The response contains exactly 3 bullet points (not 2, not 4, exactly 3)' },
      { name: 'Dash format', description: 'Each bullet point starts with a dash (-)' },
      { name: 'Topically relevant', description: 'The bullet points are about benefits of drinking water (hydration, health, energy, etc.)' },
    ],
  },
  {
    id: 'instr-2',
    category: 'Following Instructions',
    name: 'Yes/No answer only',
    messages: [
      { role: 'system', content: 'Answer the user\'s question with only "Yes" or "No". Do not add any explanation or other words.' },
      { role: 'user', content: 'Is the Earth round?' },
    ],
    criteria: [
      { name: 'Single word answer', description: 'The response is just "Yes" or "No" with no additional explanation or words' },
      { name: 'Correct answer', description: 'The answer is "Yes" (the Earth is round/spherical)' },
    ],
  },
  {
    id: 'instr-3',
    category: 'Following Instructions',
    name: 'JSON format response',
    messages: [
      { role: 'system', content: 'Always respond in valid JSON format. No other text before or after the JSON.' },
      { role: 'user', content: 'Give me a JSON object with keys "name", "color", and "legs" describing a cat.' },
    ],
    criteria: [
      { name: 'Sensible values', description: 'The JSON values make sense for describing a cat (e.g., reasonable name, realistic color, legs=4)' },
    ],
    autoChecks: [
      { name: 'Valid JSON', fn: (r) => isValidJson(r) },
      { name: 'Has all 3 keys', fn: (r) => { const j = extractJson(r); return j !== null && 'name' in j && 'color' in j && 'legs' in j; } },
    ],
  },
  {
    id: 'instr-4',
    category: 'Following Instructions',
    name: 'Words under 5 letters only',
    messages: [
      { role: 'system', content: 'You must only use words that have 5 or fewer letters. Every single word in your response must be 5 letters or shorter.' },
      { role: 'user', content: 'Tell me why the sky is blue.' },
    ],
    criteria: [
      { name: 'Short words only', description: 'All or nearly all words in the response are 5 letters or fewer. A few minor violations are acceptable but most words must comply.' },
      { name: 'Substantive answer', description: 'The response is a meaningful explanation (not just a few words) — at least 2-3 sentences that actually explain why the sky is blue' },
      { name: 'On topic', description: 'The response is about why the sky is blue (mentions light, sun, sky, etc.)' },
    ],
  },

  // ── Summarization ────────────────────────────────────────────────────────
  {
    id: 'summ-1',
    category: 'Summarization',
    name: 'Technical passage summary',
    messages: [
      { role: 'system', content: 'You are a helpful assistant that summarizes text concisely.' },
      { role: 'user', content: 'Summarize the following passage in 2-3 sentences:\n\n"Vector databases store data as high-dimensional vectors, which are mathematical representations of features or attributes. Each vector has a certain number of dimensions, ranging from tens to thousands, depending on the complexity of the data. These databases use specialized indexing methods like HNSW and IVF to enable fast similarity searches. Unlike traditional databases that use exact matching, vector databases find the most similar items using distance metrics such as cosine similarity or Euclidean distance. They are widely used in recommendation systems, image search, and natural language processing applications."' },
    ],
    criteria: [
      { name: 'Appropriate length', description: 'The summary is 2-3 sentences long, concise but complete' },
      { name: 'Captures key concepts', description: 'Mentions that vector databases store data as vectors and use similarity search (not exact matching)' },
      { name: 'Mentions applications', description: 'Mentions at least one application area (recommendations, image search, NLP, etc.)' },
      { name: 'No fabrication', description: 'Does not introduce information not present in the original passage' },
    ],
  },
  {
    id: 'summ-2',
    category: 'Summarization',
    name: 'Key points extraction',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Read the following text and list the 3 most important facts as short bullet points:\n\n"The Great Wall of China stretches over 13,000 miles across northern China. Construction began in the 7th century BC and continued for over 2,000 years. The wall was built primarily to protect against invasions from northern nomadic groups. It is made of stone, brick, tamped earth, and other materials. The wall is not a single continuous structure but consists of multiple walls and fortifications. It was designated a UNESCO World Heritage Site in 1987. Millions of workers, including soldiers, peasants, and prisoners, contributed to its construction."' },
    ],
    criteria: [
      { name: 'Bullet format', description: 'The response is formatted as bullet points (using -, *, or numbered list)' },
      { name: 'Approximately 3 points', description: 'Lists approximately 3 key facts (2-4 is acceptable)' },
      { name: 'Factually accurate', description: 'All stated facts are correct and present in the original text — no fabricated details' },
      { name: 'Good selection', description: 'The selected facts are genuinely important (e.g., length, defensive purpose, construction scale) rather than minor details' },
    ],
  },
  {
    id: 'summ-3',
    category: 'Summarization',
    name: 'One-sentence summary',
    messages: [
      { role: 'system', content: 'You are a helpful assistant. Be extremely concise.' },
      { role: 'user', content: 'Summarize this in exactly one sentence:\n\n"Photosynthesis is the process by which green plants and some other organisms use sunlight to synthesize foods from carbon dioxide and water. It generally involves the green pigment chlorophyll and generates oxygen as a byproduct. The process takes place primarily in the leaves of plants. Photosynthesis is critical for life on Earth as it produces the oxygen that most organisms need to survive and provides the base of the food chain."' },
    ],
    criteria: [
      { name: 'Single sentence', description: 'The response is exactly one sentence (not multiple sentences)' },
      { name: 'Concise', description: 'The sentence is concise and much shorter than the original passage' },
      { name: 'Captures essence', description: 'Conveys the core idea: plants use sunlight to produce food and oxygen' },
    ],
  },

  // ── Prompt Rewriting ─────────────────────────────────────────────────────
  {
    id: 'rewrite-1',
    category: 'Prompt Rewriting',
    name: 'Formal to informal',
    messages: [
      { role: 'system', content: 'You are a helpful writing assistant. Rewrite text as requested while preserving the original meaning.' },
      { role: 'user', content: 'Rewrite the following sentence in a casual, informal tone. Keep the same meaning but make it sound like you\'re talking to a friend:\n\n"We would like to inform you that your application has been received and is currently under review. You will be notified of the outcome within ten business days."' },
    ],
    criteria: [
      { name: 'Informal tone', description: 'The rewrite sounds casual and friendly — uses contractions, colloquial language, or a conversational style' },
      { name: 'Meaning preserved', description: 'The core meaning is preserved: application received, under review, will hear back in ~10 days' },
      { name: 'Not a copy', description: 'The rewrite is substantially different from the original — not just minor word swaps' },
    ],
  },
  {
    id: 'rewrite-2',
    category: 'Prompt Rewriting',
    name: 'Simplify for a child',
    messages: [
      { role: 'system', content: 'You are a helpful assistant that explains things simply.' },
      { role: 'user', content: 'Explain the following to a 7-year-old child. Use very simple words and short sentences:\n\n"Gravity is a fundamental force of nature that causes objects with mass to attract one another. It is responsible for keeping planets in orbit around stars and for making objects fall to the ground on Earth."' },
    ],
    criteria: [
      { name: 'Child-appropriate language', description: 'Uses simple vocabulary that a 7-year-old would understand — avoids jargon like "fundamental", "mass", "orbit"' },
      { name: 'Correct explanation', description: 'Correctly conveys that gravity makes things fall down and keeps planets moving around the sun' },
      { name: 'Engaging style', description: 'Uses a friendly or engaging tone — could include examples, analogies, or questions a child would relate to' },
    ],
  },
  {
    id: 'rewrite-3',
    category: 'Prompt Rewriting',
    name: 'Make concise',
    messages: [
      { role: 'system', content: 'You are a concise editor. When asked to shorten text, make it shorter while keeping the core meaning.' },
      { role: 'user', content: 'Make this shorter. Reduce it to one or two sentences maximum while keeping the key information:\n\n"In today\'s rapidly evolving technological landscape, artificial intelligence has emerged as one of the most transformative and influential technologies of the 21st century. It has the potential to revolutionize numerous industries, including healthcare, finance, education, and transportation, by automating complex tasks, improving decision-making processes, and enabling new capabilities that were previously thought to be impossible."' },
    ],
    criteria: [
      { name: 'Significantly shorter', description: 'The rewrite is much shorter than the original — ideally 1-2 sentences, noticeably more concise' },
      { name: 'Key info retained', description: 'Retains the key message: AI is transformative and impacts multiple industries' },
      { name: 'Reads well', description: 'The shortened version is grammatically correct and reads naturally' },
    ],
  },

  // ── Tool Use ─────────────────────────────────────────────────────────────
  {
    id: 'tool-1',
    category: 'Tool Use',
    name: 'Single tool: get_weather',
    messages: [
      { role: 'system', content: 'You are a helpful assistant with access to tools. Use the provided tools when needed to answer the user\'s question.' },
      { role: 'user', content: 'What is the weather like in Paris today?' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the current weather for a given city',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string', description: 'The city name' },
              unit: { type: 'string', description: 'Temperature unit', enum: ['celsius', 'fahrenheit'] },
            },
            required: ['city'],
          },
        },
      },
    ],
    criteria: [],
    autoChecks: [
      { name: 'Uses tool call', fn: (_r, tc) => Array.isArray(tc) && tc.length > 0 },
      { name: 'Calls get_weather', fn: (_r, tc) => tc?.some(t => t.function?.name === 'get_weather') ?? false },
      { name: 'city=Paris', fn: (_r, tc) => tc?.some(t => {
        const args = t.function?.arguments;
        return args && typeof args.city === 'string' && (args.city as string).toLowerCase().includes('paris');
      }) ?? false },
    ],
  },
  {
    id: 'tool-2',
    category: 'Tool Use',
    name: 'Choose correct tool from 3',
    messages: [
      { role: 'system', content: 'You are a helpful assistant with access to tools. Always use the most appropriate tool for the user\'s request.' },
      { role: 'user', content: 'Send an email to alice@example.com saying "Meeting moved to 3pm"' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the current weather for a city',
          parameters: { type: 'object', properties: { city: { type: 'string', description: 'City name' } }, required: ['city'] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'send_email',
          description: 'Send an email to a recipient',
          parameters: {
            type: 'object',
            properties: {
              to: { type: 'string', description: 'Recipient email address' },
              subject: { type: 'string', description: 'Email subject line' },
              body: { type: 'string', description: 'Email body text' },
            },
            required: ['to', 'body'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'search_web',
          description: 'Search the web for information',
          parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] },
        },
      },
    ],
    criteria: [],
    autoChecks: [
      { name: 'Uses tool call', fn: (_r, tc) => Array.isArray(tc) && tc.length > 0 },
      { name: 'Calls send_email', fn: (_r, tc) => tc?.some(t => t.function?.name === 'send_email') ?? false },
      { name: 'Correct recipient', fn: (_r, tc) => tc?.some(t => {
        const args = t.function?.arguments;
        return args && typeof args.to === 'string' && (args.to as string).includes('alice@example.com');
      }) ?? false },
      { name: 'Message content included', fn: (_r, tc) => tc?.some(t => {
        const args = t.function?.arguments;
        const body = typeof args?.body === 'string' ? args.body as string : '';
        return body.toLowerCase().includes('3pm') || body.toLowerCase().includes('3 pm') || body.toLowerCase().includes('meeting');
      }) ?? false },
    ],
  },
  {
    id: 'tool-3',
    category: 'Tool Use',
    name: 'Tool with multiple required args',
    messages: [
      { role: 'system', content: 'You are a helpful assistant with access to tools. Use tools when appropriate.' },
      { role: 'user', content: 'Create a reminder for tomorrow at 9am to buy groceries.' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'create_reminder',
          description: 'Create a new reminder',
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'The reminder title or description' },
              date: { type: 'string', description: 'The date for the reminder (YYYY-MM-DD format)' },
              time: { type: 'string', description: 'The time for the reminder (HH:MM format)' },
            },
            required: ['title', 'date', 'time'],
          },
        },
      },
    ],
    criteria: [],
    autoChecks: [
      { name: 'Uses tool call', fn: (_r, tc) => Array.isArray(tc) && tc.length > 0 },
      { name: 'Calls create_reminder', fn: (_r, tc) => tc?.some(t => t.function?.name === 'create_reminder') ?? false },
      { name: 'Title about groceries', fn: (_r, tc) => tc?.some(t => {
        const args = t.function?.arguments;
        return args && typeof args.title === 'string' && (args.title as string).toLowerCase().includes('grocer');
      }) ?? false },
      { name: 'All 3 required args', fn: (_r, tc) => tc?.some(t => {
        const args = t.function?.arguments;
        return args && 'title' in args && 'date' in args && 'time' in args;
      }) ?? false },
    ],
  },
];

// ---------------------------------------------------------------------------
// Test Runner
// ---------------------------------------------------------------------------

async function runTestCase(model: string, tc: TestCase): Promise<TestResult> {
  const result = await ollamaChat(model, tc.messages, { tools: tc.tools });

  const checkResults: CheckResult[] = [];

  // Run auto checks (objectively verifiable)
  if (tc.autoChecks) {
    for (const check of tc.autoChecks) {
      const passed = check.fn(result.content, result.toolCalls);
      checkResults.push({ name: check.name, passed, reason: passed ? 'Passed' : 'Failed', source: 'auto' });
    }
  }

  // Run LLM judge for subjective criteria
  if (tc.criteria.length > 0) {
    const userPrompt = tc.messages.find(m => m.role === 'user')?.content ?? '';
    const toolCallsStr = result.toolCalls && result.toolCalls.length > 0
      ? JSON.stringify(result.toolCalls)
      : undefined;

    const verdicts = await judgeResponse(
      `${tc.category}: ${tc.name}`,
      userPrompt,
      result.content,
      tc.criteria,
      toolCallsStr,
    );

    for (const v of verdicts) {
      checkResults.push({ name: v.criterion, passed: v.pass, reason: v.reason, source: 'judge' });
    }
  }

  return {
    testCase: tc,
    model,
    response: result.content,
    toolCalls: result.toolCalls,
    checkResults,
    passCount: checkResults.filter(c => c.passed).length,
    totalChecks: checkResults.length,
    durationMs: result.durationMs,
  };
}

async function runAllTests(model: string): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (const tc of TEST_CASES) {
    process.stdout.write(`  ${tc.id.padEnd(12)} ${tc.name.padEnd(36)}`);
    try {
      const result = await runTestCase(model, tc);
      const status = result.passCount === result.totalChecks ? 'PASS' : 'PARTIAL';
      const icon = status === 'PASS' ? 'OK' : `${result.passCount}/${result.totalChecks}`;
      console.log(icon);
      results.push(result);
    } catch (err) {
      console.log('ERROR');
      const totalChecks = (tc.autoChecks?.length ?? 0) + tc.criteria.length;
      results.push({
        testCase: tc,
        model,
        response: `ERROR: ${err}`,
        checkResults: [
          ...(tc.autoChecks?.map(c => ({ name: c.name, passed: false, reason: 'Error', source: 'auto' as const })) ?? []),
          ...tc.criteria.map(c => ({ name: c.name, passed: false, reason: 'Error', source: 'judge' as const })),
        ],
        passCount: 0,
        totalChecks,
        durationMs: 0,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Output Formatting
// ---------------------------------------------------------------------------

function printModelResults(model: string, results: TestResult[]): void {
  console.log();
  console.log(`${'═'.repeat(106)}`);
  console.log(`  Results — ${model}`);
  console.log(`${'═'.repeat(106)}`);

  const hdr = [
    'Category'.padEnd(24),
    'Test'.padEnd(36),
    'Score'.padStart(8),
    'Status'.padStart(10),
    'Judge'.padStart(8),
    'Auto'.padStart(8),
  ].join('│');
  console.log(`│${hdr}│`);
  console.log(`│${'─'.repeat(24)}│${'─'.repeat(36)}│${'─'.repeat(8)}│${'─'.repeat(10)}│${'─'.repeat(8)}│${'─'.repeat(8)}│`);

  for (const r of results) {
    const status = r.passCount === r.totalChecks ? 'PASS' : r.passCount === 0 ? 'FAIL' : 'PARTIAL';
    const judgeChecks = r.checkResults.filter(c => c.source === 'judge');
    const autoChecks = r.checkResults.filter(c => c.source === 'auto');
    const judgePassed = judgeChecks.filter(c => c.passed).length;
    const autoPassed = autoChecks.filter(c => c.passed).length;

    const judgeStr = judgeChecks.length > 0 ? `${judgePassed}/${judgeChecks.length}` : '-';
    const autoStr = autoChecks.length > 0 ? `${autoPassed}/${autoChecks.length}` : '-';

    const row = [
      r.testCase.category.padEnd(24),
      r.testCase.name.padEnd(36),
      `${r.passCount}/${r.totalChecks}`.padStart(8),
      status.padStart(10),
      judgeStr.padStart(8),
      autoStr.padStart(8),
    ].join('│');
    console.log(`│${row}│`);
  }

  console.log(`│${'─'.repeat(24)}│${'─'.repeat(36)}│${'─'.repeat(8)}│${'─'.repeat(10)}│${'─'.repeat(8)}│${'─'.repeat(8)}│`);

  // Print failed checks detail
  const failures = results.filter(r => r.passCount < r.totalChecks);
  if (failures.length > 0) {
    console.log();
    console.log(`  Failed checks for ${model}:`);
    for (const r of failures) {
      const failed = r.checkResults.filter(c => !c.passed);
      console.log(`    ${r.testCase.id} (${r.testCase.name}):`);
      for (const f of failed) {
        const tag = f.source === 'judge' ? '[judge]' : '[auto] ';
        console.log(`      FAIL ${tag} ${f.name}: ${f.reason}`);
      }
      const snippet = r.toolCalls && r.toolCalls.length > 0
        ? `[tool_calls: ${JSON.stringify(r.toolCalls).slice(0, 120)}...]`
        : r.response.replace(/\n/g, ' ').slice(0, 120);
      console.log(`      Response: "${snippet}${snippet.length >= 120 ? '...' : ''}"`);
    }
  }
}

function printComparison(allResults: Map<string, TestResult[]>): void {
  const models = [...allResults.keys()];
  const categories = ['Following Instructions', 'Summarization', 'Prompt Rewriting', 'Tool Use'];

  console.log();
  console.log(`${'═'.repeat(100)}`);
  console.log(`  Quality Comparison (judge: ${JUDGE_MODEL})`);
  console.log(`${'═'.repeat(100)}`);

  const colW = Math.max(16, Math.floor(50 / models.length));
  const hdr = [
    'Category'.padEnd(28),
    ...models.map(m => m.padStart(colW)),
    'Delta'.padStart(14),
  ].join('│');
  console.log(`│${hdr}│`);
  console.log(`│${'─'.repeat(28)}│${models.map(() => '─'.repeat(colW)).join('│')}│${'─'.repeat(14)}│`);

  const totalsByModel = new Map<string, { passed: number; total: number }>();
  for (const m of models) totalsByModel.set(m, { passed: 0, total: 0 });

  for (const cat of categories) {
    const cells: string[] = [];
    const rates: number[] = [];

    for (const m of models) {
      const catResults = allResults.get(m)!.filter(r => r.testCase.category === cat);
      const passed = catResults.reduce((s, r) => s + r.passCount, 0);
      const total = catResults.reduce((s, r) => s + r.totalChecks, 0);
      const rate = total > 0 ? passed / total : 0;
      rates.push(rate);
      cells.push(`${Math.round(rate * 100)}% (${passed}/${total})`);

      const t = totalsByModel.get(m)!;
      t.passed += passed;
      t.total += total;
    }

    const delta = rates.length >= 2 ? `${rates[rates.length - 1] - rates[0] > 0 ? '+' : ''}${Math.round((rates[rates.length - 1] - rates[0]) * 100)}%` : '';

    const row = [
      cat.padEnd(28),
      ...cells.map(c => c.padStart(colW)),
      delta.padStart(14),
    ].join('│');
    console.log(`│${row}│`);
  }

  // Overall
  console.log(`│${'─'.repeat(28)}│${models.map(() => '─'.repeat(colW)).join('│')}│${'─'.repeat(14)}│`);

  const overallCells: string[] = [];
  const overallRates: number[] = [];
  for (const m of models) {
    const t = totalsByModel.get(m)!;
    const rate = t.total > 0 ? t.passed / t.total : 0;
    overallRates.push(rate);
    overallCells.push(`${Math.round(rate * 100)}% (${t.passed}/${t.total})`);
  }

  const overallDelta = overallRates.length >= 2
    ? `${overallRates[overallRates.length - 1] - overallRates[0] > 0 ? '+' : ''}${Math.round((overallRates[overallRates.length - 1] - overallRates[0]) * 100)}%`
    : '';

  const overallRow = [
    'OVERALL'.padEnd(28),
    ...overallCells.map(c => c.padStart(colW)),
    overallDelta.padStart(14),
  ].join('│');
  console.log(`│${overallRow}│`);
  console.log(`│${'─'.repeat(28)}│${models.map(() => '─'.repeat(colW)).join('│')}│${'─'.repeat(14)}│`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║    Ollama Quality Benchmark (LLM-as-Judge) — Trovec      ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Host:        ${BASE_URL.padEnd(41)}║`);
  console.log(`║  Models:      ${LLM_MODELS.join(', ').padEnd(41)}║`);
  console.log(`║  Judge:       ${JUDGE_MODEL.padEnd(41)}║`);
  console.log(`║  Temperature: ${String(TEMPERATURE).padEnd(41)}║`);
  console.log(`║  Tests:       ${`${TEST_CASES.length} test cases across 4 categories`.padEnd(41)}║`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  // Check connectivity
  try {
    const res = await fetch(`${BASE_URL}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    console.error(`\n❌ Cannot reach Ollama at ${BASE_URL}. Is the container running?\n`);
    process.exit(1);
  }

  const allResults = new Map<string, TestResult[]>();

  for (const model of LLM_MODELS) {
    process.stdout.write(`\n⏳ Warming up ${model}...`);
    await ollamaChat(model, [{ role: 'user', content: 'Hi' }]);
    console.log(' done.');

    process.stdout.write(`⏳ Warming up judge (${JUDGE_MODEL})...`);
    await ollamaChat(JUDGE_MODEL, [{ role: 'user', content: 'Hi' }]);
    console.log(' done.\n');

    console.log(`Running quality tests for ${model}:`);
    const results = await runAllTests(model);
    allResults.set(model, results);
    printModelResults(model, results);
  }

  printComparison(allResults);

  console.log('\n✅ Quality benchmark complete.\n');
}

main().catch((err) => {
  console.error('Quality benchmark failed:', err);
  process.exit(1);
});
