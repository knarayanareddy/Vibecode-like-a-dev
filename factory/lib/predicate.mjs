/**
 * Declarative predicates.
 *
 * Routing rules live in JSON so that a human can audit *why* a practice was
 * selected, and so an agent can reason about the selection without executing
 * code. That auditability is the whole point: an unexplained checklist is just
 * cargo cult.
 *
 * Shape:
 *   { "all": [ ... ] }              every child must pass
 *   { "any": [ ... ] }              at least one child must pass
 *   { "not": { ... } }              negation
 *   { "always": true }              unconditional
 *   { "field": "risks.payments", "eq": true }
 *   { "field": "traits", "includes": "realtime" }
 *   { "field": "constraints.weeks", "gte": 8 }
 */

export function getPath(object, path) {
  return String(path)
    .split('.')
    .reduce((current, key) => (current == null ? undefined : current[key]), object);
}

function compare(actual, op, expected) {
  switch (op) {
    case 'eq':
      return actual === expected;
    case 'ne':
      return actual !== expected;
    case 'gt':
      return typeof actual === 'number' && actual > expected;
    case 'gte':
      return typeof actual === 'number' && actual >= expected;
    case 'lt':
      return typeof actual === 'number' && actual < expected;
    case 'lte':
      return typeof actual === 'number' && actual <= expected;
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    case 'includes':
      if (Array.isArray(actual)) return actual.includes(expected);
      if (typeof actual === 'string') return actual.includes(String(expected));
      return false;
    case 'exists':
      return expected ? actual !== undefined && actual !== null : actual == null;
    case 'truthy':
      return Boolean(actual) === Boolean(expected === undefined ? true : expected);
    default:
      throw new Error(`Unknown predicate operator: ${op}`);
  }
}

const OPERATORS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'includes', 'exists', 'truthy'];

export function evaluate(predicate, context) {
  if (predicate === undefined || predicate === null) return true;
  if (predicate === true) return true;
  if (predicate === false) return false;

  if (Array.isArray(predicate)) return predicate.every((child) => evaluate(child, context));

  if (typeof predicate === 'object') {
    if ('always' in predicate) return Boolean(predicate.always);
    if ('all' in predicate) return predicate.all.every((child) => evaluate(child, context));
    if ('any' in predicate) return predicate.any.some((child) => evaluate(child, context));
    if ('not' in predicate) return !evaluate(predicate.not, context);

    if ('field' in predicate) {
      const unknown = Object.keys(predicate).filter((key) => key !== 'field' && !OPERATORS.includes(key));
      if (unknown.length > 0) {
        throw new Error(`Unknown predicate operator(s): ${unknown.join(', ')} on field "${predicate.field}"`);
      }
      const actual = getPath(context, predicate.field);
      const ops = OPERATORS.filter((op) => op in predicate);
      if (ops.length === 0) return Boolean(actual);
      return ops.every((op) => compare(actual, op, predicate[op]));
    }
  }

  throw new Error(`Unsupported predicate: ${JSON.stringify(predicate)}`);
}

/** Human-readable rendering of a predicate, shown in selection rationales. */
export function explain(predicate) {
  if (predicate === true || predicate === undefined) return 'always';
  if (predicate === false) return 'never';
  if (typeof predicate !== 'object') return String(predicate);
  if ('always' in predicate) return predicate.always ? 'always' : 'never';
  if ('all' in predicate) return predicate.all.map(explain).join(' AND ');
  if ('any' in predicate) return `(${predicate.any.map(explain).join(' OR ')})`;
  if ('not' in predicate) return `NOT (${explain(predicate.not)})`;
  if ('field' in predicate) {
    const ops = OPERATORS.filter((op) => op in predicate);
    return ops.map((op) => `${predicate.field} ${op} ${JSON.stringify(predicate[op])}`).join(' AND ');
  }
  return JSON.stringify(predicate);
}
