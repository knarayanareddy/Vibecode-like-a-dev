/**
 * Minimal, dependency-free frontmatter parser.
 *
 * Supports exactly the subset this repo uses, which is deliberate: primitives are
 * authored by humans and read by agents, so the format must stay boring and
 * greppable. No nested objects, no multi-line strings, no YAML library.
 *
 *   ---
 *   id: testing.tdd-loop
 *   tier_min: 1
 *   cost: low
 *   tags: [tdd, tests, red-green-refactor]
 *   ---
 */

const TRUE = new Set(['true', 'yes']);
const FALSE = new Set(['false', 'no']);

function parseScalar(raw) {
  const value = raw.trim();
  if (value === '') return '';

  // Inline list: [a, b, c]
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    return inner
      .split(',')
      .map((item) => parseScalar(item))
      .filter((item) => item !== '');
  }

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  const lower = value.toLowerCase();
  if (TRUE.has(lower)) return true;
  if (FALSE.has(lower)) return false;

  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^-?\d*\.\d+$/.test(value)) return Number.parseFloat(value);

  return value;
}

export function parseFrontmatter(source) {
  const text = source.replace(/^\uFEFF/, '');

  if (!text.startsWith('---')) {
    return { data: {}, body: text };
  }

  const lines = text.split(/\r?\n/);
  let closing = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      closing = i;
      break;
    }
  }

  if (closing === -1) {
    return { data: {}, body: text };
  }

  const data = {};
  for (const line of lines.slice(1, closing)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1);
    if (key === '') continue;
    data[key] = parseScalar(rawValue);
  }

  return { data, body: lines.slice(closing + 1).join('\n') };
}

/** Strip the first markdown heading and return it, used to keep index titles fresh. */
export function firstHeading(body) {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '';
}
