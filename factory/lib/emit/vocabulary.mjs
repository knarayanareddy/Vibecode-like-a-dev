/**
 * The product's vocabulary.
 *
 * A packet stops being a form letter the moment it can name things: "a booking
 * cannot double-book a therapist" is a specification; "a record cannot
 * double-book an entity" is a template. So this module answers one question —
 * what does this product call its things? — and it has to be right, because
 * every derived sentence in every document uses the answer.
 *
 * The naive version of this (pick the most frequent long word) produced
 * sentences like "a change to how a yesterday behaves", so extraction is scored
 * and has a confidence floor. Below the floor we do not guess: we use the
 * fallback noun for the product's kind, which reads correctly and is honest
 * about knowing less.
 */

/**
 * Words that are never a domain noun, however often they appear. Function words,
 * reporting verbs, and the vocabulary every idea shares (so that "a change to
 * how a system behaves" cannot happen either).
 */
const NEVER_A_NOUN = new Set([
  'must', 'never', 'always', 'that', 'this', 'with', 'from', 'they', 'them', 'their', 'there', 'these',
  'those', 'when', 'then', 'than', 'which', 'while', 'where', 'what', 'have', 'been', 'will', 'would',
  'should', 'could', 'each', 'every', 'some', 'such', 'only', 'also', 'into', 'over', 'under',
  'about', 'because', 'between', 'within', 'without', 'after', 'before', 'during', 'through', 'using',
  'used', 'make', 'makes', 'made', 'take', 'takes', 'give', 'gives', 'show', 'shows', 'keep', 'keeps',
  'work', 'works', 'need', 'needs', 'want', 'wants', 'like', 'said', 'says', 'goes', 'going', 'gets',
  'other', 'another', 'people', 'person', 'thing', 'things', 'something', 'anything', 'everyone',
  'whose', 'still', 'even', 'just', 'very', 'much', 'many', 'more', 'most', 'less', 'least',
  'first', 'second', 'third', 'next', 'last', 'same', 'different', 'possible', 'available', 'required',
  'users', 'user', 'application', 'service', 'system', 'product', 'records', 'record', 'data', 'app',
  'tool', 'stuff', 'able', 'allow', 'allows', 'allowed', 'ensure', 'ensures', 'provide', 'provides',
  'support', 'supports', 'including', 'includes', 'based', 'across', 'becomes', 'become', 'happens',
  'happen', 'takes', 'runs', 'gets', 'seems', 'looks', 'means', 'means', 'needs', 'exists', 'exist',
  // Tense and frequency adverbs are the classic false positive: "a change to how a
  // yesterday behaves" comes from exactly this class of word.
  'today', 'yesterday', 'tomorrow', 'tonight', 'morning', 'evening', 'nightly', 'daily', 'weekly',
  'monthly', 'yearly', 'hourly', 'annual', 'annually', 'quarterly', 'immediately', 'automatically',
  'instantly', 'quickly', 'slowly', 'recently', 'currently', 'usually', 'always', 'sometimes',
  'therefore', 'however', 'instead', 'rather', 'already', 'again', 'later', 'soon', 'often',
  'around', 'though', 'although', 'whether', 'unless', 'until', 'since', 'still', 'rather',
  // Meta words about software rather than about *this* product.
  'feature', 'features', 'function', 'functions', 'method', 'methods', 'value', 'values', 'field',
  'fields', 'request', 'requests', 'response', 'server', 'client', 'endpoint', 'endpoints',
  'database', 'table', 'tables', 'interface', 'module', 'component', 'page', 'screen', 'button',
  'process', 'implementation', 'requirement', 'requirements', 'solution', 'project'
]);

/**
 * Suffixes that make a word a noun in English. Scored, not required: a word with
 * one still needs another signal, but two noun-ish words beat one.
 */
const NOUN_SUFFIX = /(tion|sion|ment|ness|ity|ance|ence|ship|age|ery|ist|ism|logy|graphy)$/;
/** Suffixes that make the word a verb, participle or adverb. Veto, unless anchored. */
const VERBISH = /(ly|ed|ise|ize|ises|izes|ised|ized|ating|ising|izing|ates|ifies)$/;
/** German and Dutch nouns, since ideas arrive in those languages too. */
const NON_ENGLISH_NOUN = /(ung|heit|keit|schaft|ismus|iteiten|ingen|ungen)$/;

/**
 * Adjectives, which are not nouns however often they precede one. This is a
 * grammatical veto, not a word list of the product: "the internal tool" must not
 * yield the noun "internal".
 */
const ADJECTIVE = /(al|ive|ous|able|ible|ary|est|ish|less|ful|ent|ant|ic|side|level|language|clock|rate|time|day|week|month|year|hour)$/;
const ADJECTIVE_WORDS = new Set([
  'tiny', 'large', 'small', 'simple', 'basic', 'single', 'multiple', 'several', 'entire', 'whole',
  'full', 'empty', 'long', 'short', 'fast', 'slow', 'high', 'low', 'new', 'old', 'real', 'actual',
  'correct', 'wrong', 'right', 'correct', 'clean', 'safe', 'private', 'public', 'custom', 'standard',
  'modern', 'main', 'primary', 'secondary', 'extra', 'open', 'closed', 'free', 'paid', 'live', 'dead'
]);

/**
 * Abstract software nouns: real English nouns, but not this product's things.
 * A packet that says "the evaluation" or "the version" has learned nothing about
 * the idea.
 */
const ABSTRACT = new Set([
  'evaluation', 'version', 'percent', 'difference', 'prototype', 'configuration', 'deployment',
  'migration', 'integration', 'connection', 'interaction', 'operation', 'behaviour', 'behavior',
  'content', 'detail', 'details', 'result', 'results', 'error', 'errors', 'state', 'event',
  'events', 'action', 'actions', 'option', 'options', 'setting', 'settings', 'value', 'values',
  'movement', 'reporting', 'decision', 'reason', 'help', 'amount', 'status', 'process',
  // Number words read as determiners but are not nouns.
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'hundred',
  'thousand', 'million', 'second', 'minute', 'hour', 'week', 'month', 'year', 'per', 'times',
  // Reporting verbs that a sentence uses in the third person and that a naive
  // singulariser turns into a noun ("copies" -> "copy").
  'copy', 'copies', 'send', 'sends', 'email', 'emails', 'create', 'creates', 'update', 'updates',
  'delete', 'deletes', 'import', 'imports', 'export', 'exports', 'sync', 'syncs', 'read', 'reads',
  'write', 'writes', 'list', 'lists', 'count', 'counts', 'print', 'prints', 'fetch', 'fetches',
  'depend', 'depends', 'appear', 'appears', 'remain', 'remains', 'exist', 'exists', 'occur',
  'occurs', 'contain', 'contains', 'require', 'requires', 'return', 'returns', 'accept', 'accepts'
]);

/**
 * Determiners: a word right after one of these is a noun with high probability.
 * One optional adjective is allowed between them, so "a specific therapist"
 * yields "therapist" rather than "specific".
 */
const DETERMINER = String.raw`(?:the|a|an|each|every|any|no|some|their|its|our|your|his|her|this|these|those)`;
const ANCHOR = new RegExp(
  String.raw`\b${DETERMINER}\s+(?:[a-z][a-z0-9-]*(?:al|ive|ous|able|ible|ary|est|ish|less|ful|ent|ant|ic)\s+)?([a-z][a-z0-9-]{3,})`,
  'gi'
);

const SINGULAR_RULES = [
  [/ies$/, 'y'],
  [/([sxz]|[cs]h)es$/, '$1'],
  [/(ss|us|is)es$/, '$1'],
  [/(ss|us|is)$/, null], // already singular
  [/s$/, '']
];

/** "bookings" -> "booking", "entries" -> "entry". Deliberately shallow. */
export function singularOf(word) {
  for (const [pattern, replacement] of SINGULAR_RULES) {
    if (!pattern.test(word)) continue;
    if (replacement === null) return word;
    return word.replace(pattern, replacement);
  }
  return word;
}

export function pluralOf(word) {
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** "a" or "an", so a derived noun does not produce "a engineering". */
export const articleFor = (word) => (/^[aeiou]/i.test(String(word)) ? 'an' : 'a');

const KIND_FALLBACK = {
  'web-app': ['record', 'user'],
  api: ['record', 'client'],
  cli: ['run', 'operator'],
  library: ['call', 'consumer'],
  'data-pipeline': ['dataset', 'analyst'],
  mobile: ['entry', 'user'],
  agent: ['task', 'operator'],
  automation: ['run', 'operator']
};

/**
 * Score every candidate word in the idea.
 *
 * Signals, in order of how much they are worth:
 *   - a determiner immediately before the word ("the booking") is the strongest
 *     syntactic evidence available without a parser;
 *   - a noun suffix ("pseudonymisation", "ledger");
 *   - repetition, which correlates with the idea's subject;
 *   - a plural form, which is at least not a participle.
 *
 * Vetoes: adverbs and participles, and anything in NEVER_A_NOUN.
 */
function scoreCandidates(text) {
  const words = String(text ?? '').toLowerCase();
  const tokens = words.split(/[^a-z0-9-]+/).filter((token) => token.length >= 4 && !/^\d+$/.test(token));
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

  const anchored = new Set();
  for (const match of words.matchAll(ANCHOR)) {
    const token = match[1].toLowerCase();
    anchored.add(token);
    // "the customer's order": the possessive marks the *next* word, not this one.
    if (words.slice(match.index + match[0].length, match.index + match[0].length + 2) === "'s") {
      anchored.delete(token);
    }
  }

  const scored = [];
  for (const [token, count] of counts) {
    if (NEVER_A_NOUN.has(token) || ABSTRACT.has(token) || ADJECTIVE_WORDS.has(token)) continue;
    if (/^\d+$/.test(token)) continue;

    const isAnchor = anchored.has(token);
    // A participle is only a noun when a determiner vouches for it: "a booking"
    // is a noun, "duplicating" is not. Likewise an adjective.
    // A determiner vouching for a participle is evidence ("a booking"); a
    // determiner vouching for an adjective is not ("the highest bidder").
    // A participle is never a noun, however it is anchored: nothing in a product
    // is called "a scheduled".
    if (/ed$/.test(token)) continue;
    if (VERBISH.test(token) && !isAnchor) continue;
    if (ADJECTIVE.test(token)) continue;

    let score = 0;
    if (isAnchor) score += 3;
    if (NOUN_SUFFIX.test(token)) score += 2;
    if (NON_ENGLISH_NOUN.test(token)) score += 2;
    if (count > 1) score += 1;
    if (token.includes('-')) score += 1; // "double-entry", "dead-letter": deliberate terms
    if (token.length >= 7) score += 1;
    // A word that appears once, has no noun marker and is not anchored is kept as
    // a *weak* candidate: it may still be the only noun a one-line idea gives us,
    // but it never outranks a word the sentence actually used as a noun.
    if (!isAnchor && count < 2 && !NOUN_SUFFIX.test(token) && !NON_ENGLISH_NOUN.test(token)) score = 1;
    scored.push({ word: token, count, score, anchored: isAnchor });
  }

  // Collapse the same concept in two grammatical numbers, including the German
  // plurals that -s rules do not catch ("mahnung" / "mahnungen").
  const byStem = new Map();
  for (const candidate of scored) {
    const stem = singularOf(candidate.word).replace(/en$/, '');
    const existing = byStem.get(stem);
    if (!existing || candidate.score > existing.score) {
      byStem.set(stem, { ...candidate, count: (existing?.count ?? 0) + candidate.count });
    } else {
      existing.count += candidate.count;
    }
  }

  // On a tie, the longer word is the more specific one ("order" over "copy",
  // "inventory" over "sync"), which is the opposite of the previous tiebreak.
  return [...byStem.values()].sort(
    (a, b) => b.score - a.score || b.count - a.count || b.word.length - a.word.length
  );
}

/**
 * The words a packet is allowed to use about this product.
 *
 * `primary` is a singular noun, `secondary` the actor. Both are always usable in
 * a sentence: when the idea gives us nothing above the confidence floor we fall
 * back to the noun its kind implies, and say so via `source`.
 */
export function vocabularyFor(profile) {
  const candidates = scoreCandidates(profile.idea);
  const confident = candidates.filter((candidate) => candidate.score >= 3);
  const fallback = KIND_FALLBACK[profile.kind] ?? ['record', 'user'];

  // Three levels of confidence, and the packet says which one it is on:
  //   idea   — the sentence used this word as a noun, twice or with a marker;
  //   weak   — a single plausible noun and nothing better;
  //   kind   — the idea gave us nothing nameable, so we use what the kind implies.
  const primaryPick = confident[0] ?? candidates[0] ?? null;
  const primary = primaryPick ? singularOf(primaryPick.word) : fallback[0];
  const secondaryPick =
    [...confident, ...candidates].find((candidate) => singularOf(candidate.word) !== primary) ?? null;
  const secondary = secondaryPick ? singularOf(secondaryPick.word) : fallback[1];
  const source = primaryPick ? (confident.length > 0 ? 'idea' : 'weak') : 'kind';

  return {
    primary,
    primaryPlural: pluralOf(primary),
    aPrimary: `${articleFor(primary)} ${primary}`,
    secondary,
    secondaryPlural: pluralOf(secondary),
    secondarySource: secondaryPick?.word ?? null,
    // Did we name the product, guess, or fall back to what its kind implies?
    source,
    // Candidates are singular: the ubiquitous-language table lists *things*, and
    // "bookings" next to "booking" is the synonym problem the table exists to stop.
    candidates: candidates.slice(0, 6).map((candidate) => ({ word: singularOf(candidate.word), count: candidate.count }))
  };
}

/** Candidate nouns for the ubiquitous-language table: candidates, not conclusions. */
export function ideaNouns(profile, limit = 6) {
  return vocabularyFor(profile).candidates.slice(0, limit);
}
