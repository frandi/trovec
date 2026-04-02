import { CliError } from './errors.js';

/**
 * Build a filter function from a MongoDB-style JSON filter string.
 * Supports: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $regex, $exists, $and, $or.
 * Field paths are resolved with dot notation (e.g. "context.category").
 */
export function buildFilterFn(raw: string): (context: Record<string, unknown> | undefined) => boolean {
  let filter: Record<string, unknown>;
  try {
    filter = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new CliError(
      'Invalid JSON in --filter.',
      "Provide valid JSON, e.g. --filter '{\"context.category\":\"animals\"}'",
    );
  }

  return (context) => matchesFilter(context, filter);
}

function matchesFilter(
  context: Record<string, unknown> | undefined,
  filter: Record<string, unknown>,
): boolean {
  for (const [key, condition] of Object.entries(filter)) {
    if (key === '$and') {
      const conditions = condition as Record<string, unknown>[];
      if (!conditions.every((c) => matchesFilter(context, c))) return false;
      continue;
    }

    if (key === '$or') {
      const conditions = condition as Record<string, unknown>[];
      if (!conditions.some((c) => matchesFilter(context, c))) return false;
      continue;
    }

    // Resolve field path -- strip "context." prefix if present since
    // the filter operates on the context object
    const fieldPath = key.startsWith('context.') ? key.slice(8) : key;
    const value = fieldPath === 'id' ? undefined : getNestedValue(context, fieldPath);

    if (condition != null && typeof condition === 'object' && !Array.isArray(condition)) {
      // Operator expression: { $gt: 5, $lt: 10 }
      const ops = condition as Record<string, unknown>;
      for (const [op, operand] of Object.entries(ops)) {
        if (!evalOperator(value, op, operand)) return false;
      }
    } else {
      // Shorthand equality: { field: "value" }
      if (value !== condition) return false;
    }
  }
  return true;
}

function evalOperator(value: unknown, op: string, operand: unknown): boolean {
  switch (op) {
    case '$eq': return value === operand;
    case '$ne': return value !== operand;
    case '$gt': return typeof value === 'number' && typeof operand === 'number' && value > operand;
    case '$gte': return typeof value === 'number' && typeof operand === 'number' && value >= operand;
    case '$lt': return typeof value === 'number' && typeof operand === 'number' && value < operand;
    case '$lte': return typeof value === 'number' && typeof operand === 'number' && value <= operand;
    case '$in': return Array.isArray(operand) && operand.includes(value);
    case '$nin': return Array.isArray(operand) && !operand.includes(value);
    case '$regex': return typeof value === 'string' && typeof operand === 'string' && new RegExp(operand, 'i').test(value);
    case '$exists': return operand ? value !== undefined : value === undefined;
    default: return true;
  }
}

function getNestedValue(obj: Record<string, unknown> | undefined, path: string): unknown {
  if (!obj) return undefined;
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
