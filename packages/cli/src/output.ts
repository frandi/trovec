const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
};

export type OutputFormat = 'table' | 'json' | 'jsonl' | 'csv';

export function detectFormat(explicit?: string): OutputFormat {
  if (explicit) return explicit as OutputFormat;
  return process.stdout.isTTY ? 'table' : 'json';
}

export function formatOutput(
  data: Record<string, unknown>[] | Record<string, unknown>,
  format: OutputFormat,
  options?: { includeEmbedding?: boolean },
): string {
  const rows = Array.isArray(data) ? data : [data];

  if (!options?.includeEmbedding) {
    for (const row of rows) {
      delete row.embedding;
    }
  }

  switch (format) {
    case 'json':
      return JSON.stringify(rows.length === 1 && !Array.isArray(data) ? rows[0] : rows, null, 2);
    case 'jsonl':
      return rows.map((r) => JSON.stringify(r)).join('\n');
    case 'csv':
      return formatCsv(rows);
    case 'table':
      return formatTable(rows);
  }
}

function formatCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';

  const keys = collectKeys(rows);
  const header = keys.map(csvEscape).join(',');
  const lines = rows.map((row) =>
    keys.map((k) => csvEscape(resolveValue(row, k))).join(','),
  );
  return [header, ...lines].join('\n');
}

function csvEscape(val: unknown): string {
  const s = val == null ? '' : String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function formatTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return `${c.dim}(no results)${c.reset}`;

  const keys = collectKeys(rows);
  const widths = new Map<string, number>();

  for (const key of keys) {
    widths.set(key, key.length);
  }

  const stringRows: string[][] = [];
  for (const row of rows) {
    const cells: string[] = [];
    for (const key of keys) {
      const val = formatCellValue(resolveValue(row, key));
      cells.push(val);
      widths.set(key, Math.max(widths.get(key)!, val.length));
    }
    stringRows.push(cells);
  }

  const headerLine = keys
    .map((k) => `${c.bold}${k.padEnd(widths.get(k)!)}${c.reset}`)
    .join('  ');
  const separator = keys
    .map((k) => '-'.repeat(widths.get(k)!))
    .join('  ');
  const dataLines = stringRows.map((cells) =>
    cells.map((cell, i) => cell.padEnd(widths.get(keys[i])!)).join('  '),
  );

  return [headerLine, `${c.dim}${separator}${c.reset}`, ...dataLines].join('\n');
}

function collectKeys(rows: Record<string, unknown>[]): string[] {
  const keySet = new Set<string>();
  for (const row of rows) {
    flattenKeys(row, '', keySet);
  }
  return [...keySet];
}

function flattenKeys(obj: Record<string, unknown>, prefix: string, keys: Set<string>): void {
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (val != null && typeof val === 'object' && !Array.isArray(val)) {
      flattenKeys(val as Record<string, unknown>, fullKey, keys);
    } else {
      keys.add(fullKey);
    }
  }
}

function resolveValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function formatCellValue(val: unknown): string {
  if (val == null) return '';
  if (Array.isArray(val)) return `[${val.length} items]`;
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

// Status messages (stderr, only in TTY)
export function info(message: string): void {
  if (process.stderr.isTTY) {
    process.stderr.write(`${c.cyan}${message}${c.reset}\n`);
  }
}

export function success(message: string): void {
  if (process.stderr.isTTY) {
    process.stderr.write(`${c.green}${message}${c.reset}\n`);
  }
}

export function warn(message: string): void {
  process.stderr.write(`${c.yellow}Warning: ${message}${c.reset}\n`);
}
