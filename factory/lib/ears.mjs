/**
 * EARS: Easy Approach to Requirements Syntax.
 *
 * A requirement that is one run-on sentence cannot be turned into a test, and it
 * cannot be rejected by a machine — which means it drifts, and the drift is
 * invisible until an agent builds the wrong thing. EARS (Rolls-Royce) fixes the
 * shape rather than the content:
 *
 *   ubiquitous   The <system> shall <response>.
 *   event        When <trigger>, the <system> shall <response>.
 *   state        While <state>, the <system> shall <response>.
 *   unwanted     If <condition>, then the <system> shall <response>.
 *   optional     Where <feature>, the <system> shall <response>.
 *
 * Clause order is fixed (WHERE -> WHILE -> WHEN -> IF...THEN) so a trigger can
 * never be mistaken for a precondition. Every requirement in the catalog parses
 * against one of those five, and `verify` rejects one that does not: that is the
 * only way "the spec is the interface" stays true for a machine as well as a reader.
 *
 * This is deliberately a parser, not an English analyser. It checks the shape the
 * test generator and the reviewer both depend on, and nothing beyond it.
 */

/** Words that make a response untestable. A gate cannot check "appropriately". */
const VAGUE = [
  'appropriately',
  'as needed',
  'as appropriate',
  'properly',
  'user-friendly',
  'robust',
  'reasonable',
  'etc.',
  'and so on',
  'try to',
  'should',
  'may ',
  'might',
  'could ',
  'TBD'
];

// One clause: keyword, text, delimiter (", then" only for If), then either the next
// clause or the system phrase. A comma inside the trigger is skipped because the
// lookahead only accepts a clause keyword or "the".
const CLAUSE = /^(Where|While|When|If) ([\s\S]+?)(, then|,)(?=\s*(?:(?:Where|While|When|If)\s|the\s))/i;
const ORDER = { Where: 0, While: 1, When: 2, If: 3 };
const PATTERN = {
  '': 'ubiquitous',
  Where: 'optional',
  While: 'state',
  When: 'event',
  If: 'unwanted'
};

const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * Parse one requirement statement.
 *
 * @returns {{ok: boolean, pattern: string|null, clauses: object, system: string|null,
 *            response: string|null, errors: string[]}}
 */
export function parseEars(statement) {
  const errors = [];
  const text = clean(statement);

  const empty = { ok: false, pattern: null, clauses: {}, system: null, response: null, errors };

  if (text === '') {
    errors.push('statement is empty');
    return empty;
  }
  if (!text.endsWith('.')) errors.push('statement must end with a full stop');

  const body = text.endsWith('.') ? text.slice(0, -1) : text;
  const parts = body.split(' shall ');
  if (parts.length !== 2) {
    errors.push(
      parts.length < 2
        ? 'statement has no "shall": a requirement states an obligation, not an intention'
        : 'statement has more than one "shall": one requirement is one behaviour'
    );
    return empty;
  }

  const [head, tail] = parts;
  const response = clean(tail);

  // --- clauses, left to right, in EARS order. Whatever is left is the system.
  const clauses = {};
  let rest = clean(head);
  let lastType = -1;
  for (;;) {
    const match = rest.match(CLAUSE);
    if (!match) break;
    const type = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
    const clauseText = match[2];
    const delimiter = match[3].toLowerCase();
    const order = ORDER[type];
    if (order <= lastType) {
      errors.push(`clauses must be ordered WHERE -> WHILE -> WHEN -> IF,THEN ("${type}" is out of order)`);
    }
    if (type === 'If' && delimiter !== ', then') {
      errors.push('an "If" clause must be followed by ", then"');
    }
    if (type !== 'If' && delimiter === ', then') {
      errors.push(`only an "If" clause takes ", then" (found after "${type}")`);
    }
    const key = { Where: 'feature', While: 'state', When: 'trigger', If: 'condition' }[type];
    if (clauses[key]) errors.push(`two "${type}" clauses in one statement`);
    clauses[key] = clean(clauseText);
    lastType = order;
    rest = rest.slice(match[0].length).trim();
  }

  const system = clean(rest);
  if (!/^the [a-z][\w-]*(\s[\w-]+)*$/i.test(system)) {
    errors.push(
      system === ''
        ? 'no system phrase: EARS states who is obliged ("the <system> shall ...")'
        : `the system phrase must start with "the", follow the clauses and contain no comma (got "${system}")`
    );
  }

  // --- response sanity
  if (response.length < 12) errors.push('response is too short to implement');
  const lower = ` ${response.toLowerCase()} `;
  for (const word of VAGUE) {
    if (lower.includes(` ${word}`) || lower.includes(`${word} `)) {
      errors.push(`response contains "${word.trim()}", which no test can check`);
    }
  }

  const patternKey = Object.keys(clauses).length === 0 ? '' : { feature: 'Where', state: 'While', trigger: 'When', condition: 'If' }[Object.keys(clauses).at(-1)];
  const pattern = errors.length > 0 ? null : PATTERN[patternKey] ?? null;

  return { ok: errors.length === 0, pattern, clauses, system: system || null, response: response || null, errors };
}

/** Just the verdict, for call sites that only need to refuse a bad statement. */
export const isEars = (statement) => parseEars(statement).ok;

/** One-line complaint for a CLI or a test failure. */
export function earsError(statement) {
  const { errors } = parseEars(statement);
  return errors.length === 0 ? null : errors.join('; ');
}

/** The five shapes, written out, so a tool can show them instead of describing them. */
export const EARS_PATTERNS = [
  { pattern: 'ubiquitous', template: 'The <system> shall <response>.', example: 'The application shall reject a file larger than the documented limit.' },
  { pattern: 'event', template: 'When <trigger>, the <system> shall <response>.', example: 'When an upload exceeds the limit, the application shall reject it with the limit in the message.' },
  { pattern: 'state', template: 'While <state>, the <system> shall <response>.', example: 'While a restore is running, the application shall refuse writes to the affected table.' },
  { pattern: 'unwanted', template: 'If <condition>, then the <system> shall <response>.', example: 'If the signature does not verify, then the application shall drop the event without retrying.' },
  { pattern: 'optional', template: 'Where <feature>, the <system> shall <response>.', example: 'Where multi-tenancy is enabled, the application shall resolve the tenant from the session.' }
];
