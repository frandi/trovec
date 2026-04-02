import type { TrovecEntry, TrovecHeader } from './trovecParser';

// ── Query plan types ──

export interface QueryPlan {
  command: 'find' | 'count' | 'distinct' | 'stats';
  filter?: FilterExpression;
  sort?: Record<string, 1 | -1>;
  skip?: number;
  limit?: number;
  field?: string; // for distinct
}

export type FilterExpression =
  | { type: 'field'; path: string; operator: FilterOperator; value: unknown }
  | { type: 'and'; conditions: FilterExpression[] }
  | { type: 'or'; conditions: FilterExpression[] };

export type FilterOperator =
  | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'nin' | 'regex' | 'exists';

// ── Query results ──

export interface FindResult {
  kind: 'find';
  entries: TrovecEntry[];
  total: number;
  skip: number;
  limit: number;
}

export interface CountResult {
  kind: 'count';
  count: number;
}

export interface DistinctResult {
  kind: 'distinct';
  field: string;
  values: unknown[];
}

export interface StatsResult {
  kind: 'stats';
  dimensions: number;
  quantization: string;
  metric: string;
  entryCount: number;
}

export interface ErrorResult {
  kind: 'error';
  message: string;
}

export type QueryResult = FindResult | CountResult | DistinctResult | StatsResult | ErrorResult;

// ── Parser ──

// Tokenizer
type Token =
  | { type: 'ident'; value: string }
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'bool'; value: boolean }
  | { type: 'null' }
  | { type: 'dot' }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'lbrace' }
  | { type: 'rbrace' }
  | { type: 'lbracket' }
  | { type: 'rbracket' }
  | { type: 'colon' }
  | { type: 'comma' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    // Whitespace
    if (/\s/.test(ch)) { i++; continue; }

    // Single-char tokens
    if (ch === '.') { tokens.push({ type: 'dot' }); i++; continue; }
    if (ch === '(') { tokens.push({ type: 'lparen' }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'rparen' }); i++; continue; }
    if (ch === '{') { tokens.push({ type: 'lbrace' }); i++; continue; }
    if (ch === '}') { tokens.push({ type: 'rbrace' }); i++; continue; }
    if (ch === '[') { tokens.push({ type: 'lbracket' }); i++; continue; }
    if (ch === ']') { tokens.push({ type: 'rbracket' }); i++; continue; }
    if (ch === ':') { tokens.push({ type: 'colon' }); i++; continue; }
    if (ch === ',') { tokens.push({ type: 'comma' }); i++; continue; }

    // String (double or single quoted)
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let str = '';
      while (i < input.length && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < input.length) {
          i++;
          const esc = input[i];
          if (esc === 'n') str += '\n';
          else if (esc === 't') str += '\t';
          else str += esc;
        } else {
          str += input[i];
        }
        i++;
      }
      if (i < input.length) i++; // skip closing quote
      tokens.push({ type: 'string', value: str });
      continue;
    }

    // Number (including negative)
    if (/[0-9]/.test(ch) || (ch === '-' && i + 1 < input.length && /[0-9]/.test(input[i + 1]))) {
      let num = '';
      if (ch === '-') { num += '-'; i++; }
      while (i < input.length && /[0-9.]/.test(input[i])) {
        num += input[i];
        i++;
      }
      tokens.push({ type: 'number', value: parseFloat(num) });
      continue;
    }

    // Identifier (includes $ prefix for operators)
    if (/[a-zA-Z_$]/.test(ch)) {
      let ident = '';
      while (i < input.length && /[a-zA-Z0-9_$]/.test(input[i])) {
        ident += input[i];
        i++;
      }
      if (ident === 'true') tokens.push({ type: 'bool', value: true });
      else if (ident === 'false') tokens.push({ type: 'bool', value: false });
      else if (ident === 'null') tokens.push({ type: 'null' });
      else tokens.push({ type: 'ident', value: ident });
      continue;
    }

    throw new Error(`Unexpected character '${ch}' at position ${i}`);
  }

  return tokens;
}

// Recursive descent parser
class Parser {
  private tokens: Token[];
  private pos: number;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    const tok = this.tokens[this.pos];
    if (!tok) throw new Error('Unexpected end of input');
    this.pos++;
    return tok;
  }

  private expect(type: string): Token {
    const tok = this.advance();
    if (tok.type !== type) {
      throw new Error(`Expected ${type}, got ${tok.type}`);
    }
    return tok;
  }

  parse(): QueryPlan {
    // Expect: db.method(...)...
    const first = this.advance();
    if (first.type !== 'ident' || first.value !== 'db') {
      throw new Error('Query must start with "db."');
    }
    this.expect('dot');
    const methodTok = this.advance();
    if (methodTok.type !== 'ident') {
      throw new Error('Expected method name after "db."');
    }

    const method = methodTok.value;
    let plan: QueryPlan;

    switch (method) {
      case 'find':
        plan = this.parseFind();
        break;
      case 'count':
        plan = this.parseCount();
        break;
      case 'distinct':
        plan = this.parseDistinct();
        break;
      case 'stats':
        plan = this.parseStats();
        break;
      default:
        throw new Error(`Unknown command: db.${method}(). Available: find, count, distinct, stats`);
    }

    // Parse chained methods
    while (this.peek()?.type === 'dot') {
      this.advance(); // consume dot
      const chainTok = this.advance();
      if (chainTok.type !== 'ident') {
        throw new Error('Expected method name after "."');
      }

      switch (chainTok.value) {
        case 'sort':
          this.expect('lparen');
          plan.sort = this.parseObject() as Record<string, 1 | -1>;
          this.expect('rparen');
          break;
        case 'skip':
          this.expect('lparen');
          plan.skip = this.parseNumberArg();
          this.expect('rparen');
          break;
        case 'limit':
          this.expect('lparen');
          plan.limit = this.parseNumberArg();
          this.expect('rparen');
          break;
        default:
          throw new Error(`Unknown chain method: .${chainTok.value}(). Available: sort, skip, limit`);
      }
    }

    return plan;
  }

  private parseFind(): QueryPlan {
    this.expect('lparen');
    let filter: FilterExpression | undefined;
    if (this.peek()?.type !== 'rparen') {
      const obj = this.parseObject();
      filter = this.buildFilter(obj);
    }
    this.expect('rparen');
    return { command: 'find', filter };
  }

  private parseCount(): QueryPlan {
    this.expect('lparen');
    let filter: FilterExpression | undefined;
    if (this.peek()?.type !== 'rparen') {
      const obj = this.parseObject();
      filter = this.buildFilter(obj);
    }
    this.expect('rparen');
    return { command: 'count', filter };
  }

  private parseDistinct(): QueryPlan {
    this.expect('lparen');
    const tok = this.advance();
    if (tok.type !== 'string') {
      throw new Error('db.distinct() requires a string argument (field path)');
    }
    this.expect('rparen');
    return { command: 'distinct', field: tok.value };
  }

  private parseStats(): QueryPlan {
    this.expect('lparen');
    this.expect('rparen');
    return { command: 'stats' };
  }

  private parseNumberArg(): number {
    const tok = this.advance();
    if (tok.type !== 'number') {
      throw new Error(`Expected number, got ${tok.type}`);
    }
    return tok.value;
  }

  private parseValue(): unknown {
    const tok = this.peek();
    if (!tok) throw new Error('Unexpected end of input');

    if (tok.type === 'string') { this.advance(); return tok.value; }
    if (tok.type === 'number') { this.advance(); return tok.value; }
    if (tok.type === 'bool') { this.advance(); return tok.value; }
    if (tok.type === 'null') { this.advance(); return null; }
    if (tok.type === 'lbrace') return this.parseObject();
    if (tok.type === 'lbracket') return this.parseArray();

    throw new Error(`Unexpected token: ${tok.type}`);
  }

  private parseObject(): Record<string, unknown> {
    this.expect('lbrace');
    const obj: Record<string, unknown> = {};

    if (this.peek()?.type !== 'rbrace') {
      this.parseKeyValue(obj);
      while (this.peek()?.type === 'comma') {
        this.advance();
        if (this.peek()?.type === 'rbrace') break; // trailing comma
        this.parseKeyValue(obj);
      }
    }

    this.expect('rbrace');
    return obj;
  }

  private parseKeyValue(obj: Record<string, unknown>): void {
    const keyTok = this.advance();
    let key: string;
    if (keyTok.type === 'string') {
      key = keyTok.value;
    } else if (keyTok.type === 'ident') {
      key = keyTok.value;
    } else {
      throw new Error(`Expected key, got ${keyTok.type}`);
    }
    this.expect('colon');
    obj[key] = this.parseValue();
  }

  private parseArray(): unknown[] {
    this.expect('lbracket');
    const arr: unknown[] = [];

    if (this.peek()?.type !== 'rbracket') {
      arr.push(this.parseValue());
      while (this.peek()?.type === 'comma') {
        this.advance();
        if (this.peek()?.type === 'rbracket') break;
        arr.push(this.parseValue());
      }
    }

    this.expect('rbracket');
    return arr;
  }

  // Convert a parsed object into a FilterExpression tree
  private buildFilter(obj: Record<string, unknown>): FilterExpression {
    const conditions: FilterExpression[] = [];

    for (const [key, value] of Object.entries(obj)) {
      if (key === '$and') {
        const items = value as Record<string, unknown>[];
        conditions.push({
          type: 'and',
          conditions: items.map(item => this.buildFilter(item)),
        });
      } else if (key === '$or') {
        const items = value as Record<string, unknown>[];
        conditions.push({
          type: 'or',
          conditions: items.map(item => this.buildFilter(item)),
        });
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        // Check if it's an operator object like { $gt: 5 }
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length > 0 && entries[0][0].startsWith('$')) {
          for (const [op, opVal] of entries) {
            const operator = operatorMap[op];
            if (!operator) {
              throw new Error(`Unknown operator: ${op}. Available: ${Object.keys(operatorMap).join(', ')}`);
            }
            conditions.push({ type: 'field', path: key, operator, value: opVal });
          }
        } else {
          // Exact match with nested object
          conditions.push({ type: 'field', path: key, operator: 'eq', value });
        }
      } else {
        // Simple exact match
        conditions.push({ type: 'field', path: key, operator: 'eq', value });
      }
    }

    if (conditions.length === 1) return conditions[0];
    return { type: 'and', conditions };
  }
}

const operatorMap: Record<string, FilterOperator> = {
  $eq: 'eq',
  $ne: 'ne',
  $gt: 'gt',
  $gte: 'gte',
  $lt: 'lt',
  $lte: 'lte',
  $in: 'in',
  $nin: 'nin',
  $regex: 'regex',
  $exists: 'exists',
};

// ── Filter evaluation ──

function resolvePath(entry: TrovecEntry, path: string): unknown {
  if (path === 'id') return entry.id;

  // Handle context.* paths
  if (path.startsWith('context.')) {
    const contextPath = path.slice('context.'.length);
    return getNestedValue(entry.context, contextPath);
  }

  // Also allow direct context access
  if (path === 'context') return entry.context;

  return undefined;
}

function getNestedValue(obj: unknown, path: string): unknown {
  if (obj === undefined || obj === null) return undefined;
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function matchesFilter(entry: TrovecEntry, filter: FilterExpression): boolean {
  switch (filter.type) {
    case 'and':
      return filter.conditions.every(c => matchesFilter(entry, c));
    case 'or':
      return filter.conditions.some(c => matchesFilter(entry, c));
    case 'field':
      return evaluateFieldFilter(entry, filter.path, filter.operator, filter.value);
  }
}

function evaluateFieldFilter(entry: TrovecEntry, path: string, operator: FilterOperator, value: unknown): boolean {
  const actual = resolvePath(entry, path);

  switch (operator) {
    case 'eq':
      return actual === value;
    case 'ne':
      return actual !== value;
    case 'gt':
      return typeof actual === 'number' && typeof value === 'number' && actual > value;
    case 'gte':
      return typeof actual === 'number' && typeof value === 'number' && actual >= value;
    case 'lt':
      return typeof actual === 'number' && typeof value === 'number' && actual < value;
    case 'lte':
      return typeof actual === 'number' && typeof value === 'number' && actual <= value;
    case 'in':
      return Array.isArray(value) && value.includes(actual);
    case 'nin':
      return Array.isArray(value) && !value.includes(actual);
    case 'regex': {
      if (typeof value !== 'string' || typeof actual !== 'string') return false;
      try {
        return new RegExp(value, 'i').test(actual);
      } catch {
        return false;
      }
    }
    case 'exists':
      return value ? actual !== undefined : actual === undefined;
  }
}

// ── Query execution ──

const DEFAULT_LIMIT = 50;

export function parseQuery(input: string): QueryPlan {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Empty query. Try: db.find() or db.stats()');
  }
  const tokens = tokenize(trimmed);
  const parser = new Parser(tokens);
  return parser.parse();
}

export function executeQuery(plan: QueryPlan, entries: TrovecEntry[], header: TrovecHeader): QueryResult {
  switch (plan.command) {
    case 'stats':
      return {
        kind: 'stats',
        dimensions: header.dimensions,
        quantization: header.quantization,
        metric: header.metric,
        entryCount: header.entryCount,
      };

    case 'count': {
      let filtered = entries;
      if (plan.filter) {
        filtered = entries.filter(e => matchesFilter(e, plan.filter!));
      }
      return { kind: 'count', count: filtered.length };
    }

    case 'distinct': {
      if (!plan.field) {
        return { kind: 'error', message: 'distinct requires a field argument' };
      }
      const seen = new Set<unknown>();
      for (const entry of entries) {
        const val = resolvePath(entry, plan.field);
        if (val !== undefined) seen.add(val);
      }
      return { kind: 'distinct', field: plan.field, values: Array.from(seen).sort() };
    }

    case 'find': {
      let filtered = entries;
      if (plan.filter) {
        filtered = entries.filter(e => matchesFilter(e, plan.filter!));
      }
      const total = filtered.length;

      // Sort
      if (plan.sort) {
        const sortEntries = Object.entries(plan.sort);
        filtered = [...filtered].sort((a, b) => {
          for (const [path, dir] of sortEntries) {
            const va = resolvePath(a, path);
            const vb = resolvePath(b, path);
            if (va === vb) continue;
            if (va === undefined) return 1;
            if (vb === undefined) return -1;
            if (typeof va === 'number' && typeof vb === 'number') {
              return (va - vb) * dir;
            }
            return String(va).localeCompare(String(vb)) * dir;
          }
          return 0;
        });
      }

      // Pagination
      const skip = plan.skip ?? 0;
      const limit = plan.limit ?? DEFAULT_LIMIT;
      filtered = filtered.slice(skip, skip + limit);

      return { kind: 'find', entries: filtered, total, skip, limit };
    }
  }
}

export function runQuery(input: string, entries: TrovecEntry[], header: TrovecHeader): QueryResult {
  try {
    const plan = parseQuery(input);
    return executeQuery(plan, entries, header);
  } catch (err: unknown) {
    return { kind: 'error', message: (err as Error).message };
  }
}
