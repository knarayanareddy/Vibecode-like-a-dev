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
const NOUN_SUFFIX = /(tion|sion|ment|ness|ity|ance|ence|ship|age|ery|ist|ism|logy|graphy)s?$/;
/** Suffixes that make the word a verb, participle or adverb. Veto, unless anchored. */
const VERBISH = /(ly|ed|ise|ize|ises|izes|ised|ized|ating|ising|izing|ates|ifies)$/;
/** German and Dutch nouns, since ideas arrive in those languages too. */
const NON_ENGLISH_NOUN = /(ung|heit|keit|schaft|ismus|iteiten|ingen|ungen)$/;

/**
 * Genuine person/actor and domain entity nouns whose spelling happens to end in
 * `-ant`, `-ent` or `-al`. Without this exemption, `ADJECTIVE` vetoes `participant`,
 * `patient`, `tenant`, `merchant`, `client`, `trial` and `hospital` — and `ANCHOR`
 * treats `"a participant"` as `"a <adjective>"` and anchors the verb after it
 * (`"a participant exercises"` -> `"exercises"` -> `"exercis"`).
 */
const KNOWN_NOUN_STEMS = new Set([
  'participant', 'patient', 'tenant', 'client', 'merchant', 'student', 'recipient', 'claimant',
  'applicant', 'accountant', 'resident', 'attendant', 'consultant', 'defendant', 'agent', 'parent',
  'incident', 'document', 'payment', 'settlement', 'shipment', 'appointment', 'reimbursement',
  'agreement', 'statement', 'installment', 'entitlement', 'instrument', 'department', 'comment',
  'trial', 'hospital', 'portal', 'journal', 'referral', 'approval', 'withdrawal', 'proposal',
  'credential', 'terminal', 'signal', 'material', 'deal', 'meal', 'goal'
]);

/**
 * Human/organisational actor stems so `vocabularyFor` can place the thing acted upon
 * in `primary` ("claim", "booking", "payout") and the actor in `secondary`
 * ("coordinator", "participant", "therapist", "seller") when both are present.
 */
const ACTOR_STEMS = new Set([
  'participant', 'patient', 'coordinator', 'therapist', 'clinician', 'doctor', 'nurse', 'sponsor',
  'auditor', 'reviewer', 'approver', 'operator', 'admin', 'administrator', 'moderator', 'member',
  'tenant', 'seller', 'buyer', 'merchant', 'vendor', 'supplier', 'shopper', 'subscriber', 'reader',
  'author', 'writer', 'editor', 'creator', 'owner', 'manager', 'staff', 'receptionist', 'driver',
  'rider', 'courier', 'student', 'teacher', 'instructor', 'applicant', 'claimant', 'accountant',
  'analyst', 'consumer', 'client', 'partner', 'team', 'organisation', 'organization', 'clinic',
  'hospital', 'site', 'company', 'enterprise', 'institution', 'agency', 'bank'
]);

/**
 * Adjectives, which are not nouns however often they precede one. This is a
 * grammatical veto, not a word list of the product: "the internal tool" must not
 * yield the noun "internal".
 */
const ADJECTIVE = /(al|ive|ous|able|ible|ary|est|ish|less|ful|ent|ant|ic|side|level|language|clock|rate|time|day|week|month|year|hour)$/;
const ADJECTIVE_WORDS = new Set([
  'tiny', 'large', 'small', 'simple', 'basic', 'single', 'multiple', 'several', 'entire', 'whole',
  'full', 'empty', 'long', 'short', 'fast', 'slow', 'high', 'low', 'new', 'old', 'real', 'actual',
  'correct', 'wrong', 'right', 'clean', 'safe', 'private', 'public', 'custom', 'standard',
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
  // Reporting and policy verbs that a sentence uses in the third person ("a participant
  // exercises GDPR...", "approves", "withdraws") and that a naive singulariser turns into a noun.
  'copy', 'copies', 'send', 'sends', 'email', 'emails', 'create', 'creates', 'update', 'updates',
  'delete', 'deletes', 'import', 'imports', 'export', 'exports', 'sync', 'syncs', 'read', 'reads',
  'write', 'writes', 'list', 'lists', 'count', 'counts', 'print', 'prints', 'fetch', 'fetches',
  'depend', 'depends', 'appear', 'appears', 'remain', 'remains', 'exist', 'exists', 'occur',
  'occurs', 'contain', 'contains', 'require', 'requires', 'return', 'returns', 'accept', 'accepts',
  'exercise', 'exercises', 'withdraw', 'withdraws', 'parse', 'parses', 'disburse', 'disburses',
  'approve', 'approves', 'enforce', 'enforces', 'replace', 'replaces', 'retain', 'retains',
  'capture', 'captures', 'submit', 'submits', 'handle', 'handles', 'exceed', 'exceeds'
]);

/**
 * Determiners: a word right after one of these is a noun with high probability.
 * One optional adjective is allowed between them, so "a specific therapist"
 * yields "therapist" rather than "specific" — unless the first word is itself a
 * known noun (`"a participant exercises"` must anchor `"participant"`, not `"exercises"`).
 */
const DETERMINER = String.raw`(?:the|a|an|each|every|any|no|some|their|its|our|your|his|her|this|these|those)`;
const ADJ_MODIFIER = /(?:al|ive|ous|able|ible|ary|est|ish|less|ful|ent|ant|ic)$/;
const DET_PAIR = new RegExp(
  String.raw`\b${DETERMINER}\s+([a-z][a-z0-9-]{3,})(?:\s+([a-z][a-z0-9-]{3,}))?`,
  'gi'
);

const SINGULAR_RULES = [
  [/([^aeiou])ies$/, '$1y'],
  [/(sses|xes|zzes|[cs]hes)$/, (m) => m.slice(0, -2)],
  [/\b(status|bus|gas|alias|canvas|campus|focus|virus|lens|bonus|corpus|census|nexus)es$/, '$1'],
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
const isKnownNoun = (word) => {
  const s = singularOf(word);
  return KNOWN_NOUN_STEMS.has(s) || /ments?$/.test(word);
};

const isActorWord = (word) => {
  const s = singularOf(word);
  return ACTOR_STEMS.has(s) || /(?:ist|ian)s?$/.test(word);
};

function scoreCandidates(text) {
  const words = String(text ?? '').toLowerCase();
  const tokens = words.split(/[^a-z0-9-]+/).filter((token) => token.length >= 4 && !/^\d+$/.test(token));
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

  const anchored = new Set();
  for (const match of words.matchAll(DET_PAIR)) {
    const first = match[1].toLowerCase();
    const second = match[2]?.toLowerCase() ?? null;
    const firstIsModifier = (ADJECTIVE_WORDS.has(first) || ADJ_MODIFIER.test(first)) && !isKnownNoun(first);
    const chosen = firstIsModifier && second ? second : first;
    const endOffset = firstIsModifier && second ? match.index + match[0].length : match.index + match[0].length - (match[2] ? match[2].length + 1 : 0);
    anchored.add(chosen);
    // "the customer's order": the possessive marks the *next* word, not this one.
    if (words.slice(endOffset, endOffset + 2) === "'s") {
      anchored.delete(chosen);
      if (second && chosen === first) anchored.add(second);
    }
  }

  // Collapse singular/plural (and German -en plurals) BEFORE computing repetition and
  // anchor scores, so "a claim" (1x, anchored) + "claims" (2x) earns both its anchor
  // and its 3x repetition instead of losing to a 1x hyphenated failure term like
  // "double-disbursement".
  const groups = new Map();
  for (const [token, count] of counts) {
    if (NEVER_A_NOUN.has(token) || ABSTRACT.has(token) || ADJECTIVE_WORDS.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    if (/ed$/.test(token)) continue;
    const isAnchor = anchored.has(token);
    const knownNoun = isKnownNoun(token);
    if (VERBISH.test(token) && !isAnchor) continue;
    if (ADJECTIVE.test(token) && !knownNoun) continue;

    const stem = singularOf(token).replace(/en$/, '');
    const canonical = singularOf(token);
    const prev = groups.get(stem);
    if (!prev) {
      groups.set(stem, {
        word: canonical,
        rawTokens: [token],
        count,
        anchored: isAnchor,
        knownNoun,
        nounSuffix: NOUN_SUFFIX.test(token) || NOUN_SUFFIX.test(canonical),
        nonEnglishNoun: NON_ENGLISH_NOUN.test(token)
      });
    } else {
      prev.count += count;
      prev.anchored = prev.anchored || isAnchor;
      prev.knownNoun = prev.knownNoun || knownNoun;
      prev.nounSuffix = prev.nounSuffix || NOUN_SUFFIX.test(token) || NOUN_SUFFIX.test(canonical);
      prev.nonEnglishNoun = prev.nonEnglishNoun || NON_ENGLISH_NOUN.test(token);
      prev.rawTokens.push(token);
    }
  }

  const scored = [];
  for (const entry of groups.values()) {
    const { word, count, anchored: isAnchor, knownNoun, nounSuffix, nonEnglishNoun } = entry;
    const hyphenated = word.includes('-');
    let score = 0;
    if (isAnchor) score += 3;
    if (nounSuffix || knownNoun) score += 2;
    if (nonEnglishNoun) score += 2;
    if (count > 1) score += 1;
    if (count >= 3) score += 1;
    // Hyphenated terms ("double-entry", "dead-letter") are great glossary candidates,
    // so give +1 when anchored or repeated, not on a 1x unanchored negative ("double-disbursement").
    if (hyphenated && (isAnchor || count > 1)) score += 1;
    if (!hyphenated && word.length >= 7) score += 1;
    if (!isAnchor && count < 2 && !nounSuffix && !nonEnglishNoun && !knownNoun) score = 1;
    scored.push({ word, count, score, anchored: isAnchor });
  }

  // On a tie, the longer word is the more specific one ("order" over "copy",
  // "inventory" over "sync"), which is the opposite of the previous tiebreak.
  return scored.sort(
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
  // Prefer a domain object ("claim", "booking", "reimbursement") for `primary` and a
  // human/org role ("participant", "coordinator", "therapist") for `secondary` when
  // the confident pool contains both, so sentences like "a participant's claim" read
  // naturally instead of "an exercis's sponsor".
  const primaryPool = confident.length > 0 ? confident : candidates;
  const topObject = primaryPool.find((candidate) => !isActorWord(candidate.word)) ?? null;
  const primaryPick = topObject ?? primaryPool[0] ?? null;
  const primary = primaryPick ? singularOf(primaryPick.word) : fallback[0];
  const restPool = [...confident, ...candidates].filter((candidate) => singularOf(candidate.word) !== primary);
  const topActor = confident.find((candidate) => singularOf(candidate.word) !== primary && isActorWord(candidate.word)) ?? null;
  const secondaryPick = topActor ?? restPool[0] ?? null;
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
