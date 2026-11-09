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
  // The delivery form, not the thing delivered. "A platform to manage appointments"
  // used to produce a packet whose noun was `platform`.
  'platform', 'platforms',
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
/**
 * Abstract nouns that name an *outcome*, not a thing the product manages. They are
 * the vocabulary of a bug report, and an idea mentions them in passing ("a summary
 * of failures") far more often than it builds around them.
 */
const ABSTRACT_OUTCOME = /(tion|sion|ment|ness|ity|ure)$/;
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
  // Short domain nouns that fall under the four-character token floor.
  'gym', 'spa', 'tax', 'vat', 'job', 'car', 'van', 'pet', 'art', 'pod', 'map',
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
  'auditor', 'reviewer', 'approver', 'operator', 'dispatcher', 'aggregator', 'host', 'admin',
  'administrator', 'moderator', 'member', 'tenant', 'seller', 'buyer', 'merchant', 'vendor',
  'supplier', 'distributor', 'wholesaler', 'retailer', 'manufacturer', 'producer', 'grower',
  'farmer', 'shopper', 'subscriber', 'reader', 'author', 'writer', 'editor', 'creator', 'owner',
  'manager', 'director', 'supervisor', 'inspector', 'regulator', 'contractor', 'subcontractor',
  'broker', 'dealer', 'underwriter', 'adjuster', 'investor', 'advisor', 'counselor', 'mediator',
  'arbitrator', 'issuer', 'borrower', 'lender', 'payer', 'payee', 'beneficiary', 'carrier',
  'shipper', 'importer', 'exporter', 'consignee', 'consignor', 'declarant', 'employer', 'employee',
  'recruiter', 'candidate', 'trainee', 'attendee', 'organizer',
  'organiser', 'volunteer', 'donor', 'custodian', 'guardian', 'caregiver', 'pharmacist',
  'practitioner', 'technician', 'scheduler', 'assessor', 'officer', 'clerk', 'cashier', 'landlord',
  // Organisations are actors too: "a clinic" books, a "team" votes, a "school" enrols.
  'clinic', 'hospital', 'practice', 'school', 'team', 'company', 'organisation', 'organization',
  'agency', 'bank', 'store', 'shop', 'restaurant', 'firm', 'department', 'studio', 'gym',
  'pharmacy', 'laboratory', 'provider', 'insurer', 'university', 'charity', 'cooperative',
  'lessee', 'lessor', 'renter', 'guest', 'passenger', 'staff', 'receptionist', 'driver', 'rider',
  'courier', 'student', 'teacher', 'instructor', 'applicant', 'claimant', 'accountant', 'analyst',
  'consumer', 'client', 'partner', 'team', 'organisation', 'organization', 'clinic', 'hospital',
  'site', 'company', 'enterprise', 'institution', 'agency', 'bank'
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
  'modern', 'main', 'primary', 'secondary', 'extra', 'open', 'closed', 'free', 'paid', 'live', 'dead',
  'boutique', 'small-business', 'enterprise', 'premium', 'budget', 'local', 'global', 'internal',
  'external', 'personal', 'professional', 'independent', 'upcoming', 'current', 'previous',
  // Quality adjectives: they read as praise, not as a thing a product owns.
  // "Something nice for people who like things" produced the noun `nice`, and the
  // packet rendered "One nice goes from created to finished" in every template.
  'nice', 'good', 'bad', 'great', 'better', 'best', 'easy', 'hard', 'simple', 'complex',
  'beautiful', 'pretty', 'awesome', 'amazing', 'cool', 'useful', 'helpful', 'powerful',
  'smart', 'clever', 'efficient', 'reliable', 'robust', 'scalable', 'secure', 'modern',
  'intuitive', 'seamless', 'flexible', 'lightweight', 'quick', 'instant', 'automatic'
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
 * Software-shape nouns: the word a product is packaged as, not the thing it manages.
 *
 * "A multi-tenant telehealth platform" names the *delivery form*. Promoting
 * `telehealth` — the modifier that happens to sit in the determiner chain — made a
 * packet say "One telehealth goes from created to finished" 307 times. These words
 * are legitimate heads when nothing better exists, so they stay usable, but they
 * lose to a word that names an actual domain object.
 */
const ABSTRACT_SOFTWARE_NOUNS = new Set([
  'platform', 'app', 'application', 'service', 'system', 'tool', 'solution', 'product',
  'site', 'website', 'portal', 'dashboard', 'saas', 'software', 'suite', 'engine',
  'framework', 'library', 'plugin', 'extension', 'marketplace', 'startup', 'business'
]);

/**
 * Nouns the idea says the product must NOT produce.
 *
 * "The product must never give a diagnosis" both states a rule and names a noun.
 * The term table used to list `diagnosis` as a term to agree on, which invites an
 * agent to build it — the opposite of what the sentence asked for.
 *
 * This is deliberately narrow, because a wrong classification removes a real domain
 * noun from the packet, which is worse than listing one extra term. It fires only
 * on:
 *
 *   - a negation in production verbs, where the verb is what would create the
 *     thing: give, produce, return, emit, generate, present, show, display, offer,
 *     suggest, recommend;
 *   - "must not" / "shall not" / "never" introducing one of those verbs;
 *   - a direct object within the same clause, so "never lose a settlement" does not
 *     make `settlement` forbidden (lose is not a production verb, and losing one is
 *     not the product producing it).
 *
 * The negation has to be adjacent to the verb: "must never give a diagnosis", not
 * "must keep records and never give a diagnosis" scored loosely.
 */
const PRODUCTION_VERB =
  /(?:give|gives|produce|produces|return|returns|emit|emits|generate|generates|present|presents|show|shows|display|displays|offer|offers|suggest|suggests|recommend|recommends)/i;
const NEGATED_PRODUCTION =
  /\b(?:must|shall|will|should)\s+not\s+(?:ever\s+)?(?:give|produce|return|emit|generate|present|show|display|offer|suggest|recommend)\b|\b(?:must|shall|will|should)\s+(?:never|not)\s+(?:give|produce|return|emit|generate|present|show|display|offer|suggest|recommend)\b|\bnever\s+(?:give|produce|return|emit|generate|present|show|display|offer|suggest|recommend)\b/i;

/** Words that are never the noun being forbidden. */
const NOT_A_DOMAIN_NOUN = new Set([
  'a', 'an', 'the', 'any', 'this', 'that', 'these', 'those', 'it', 'them', 'one',
  'advice', 'guidance', 'information', 'answers', 'answer', 'results', 'result',
  'output', 'outputs', 'content', 'data', 'text', 'response', 'responses'
]);

/**
 * The nouns an idea negates, as written. Returns [] when the sentence does not
 * match the narrow shape above, which is the common case.
 */
export function forbiddenNounsFor(idea) {
  const found = [];
  const sentences = String(idea ?? '')
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((sentence) => sentence.trim());
  for (const sentence of sentences) {
    if (!NEGATED_PRODUCTION.test(sentence)) continue;
    // The object follows the negated verb: "... never give a diagnosis" -> diagnosis.
    const match = NEGATED_PRODUCTION.exec(sentence);
    const rest = sentence.slice(match.index + match[0].length);
    // Stop at a clause boundary so the object is the verb's own object.
    // Stop at a clause boundary or a preposition: in "return patient data to third
    // parties", the object of `return` is "patient data", and "parties" belongs to
    // the prepositional phrase.
    const objectClause = rest.split(/[,;]|\b(?:and|but|while|because|which|that|so|to|for|from|into|with|without|on|at)\b/i)[0] ?? '';
    const words = objectClause.trim().replace(/[.!?]+$/, '').split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    // The head noun is the LAST content word of the object clause: "patient data"
    // is a kind of data, not a kind of patient, and taking the first word would
    // forbid `patient` — a noun the product certainly does have.
    const content = words.filter((word) => !['a', 'an', 'the', 'any', 'this', 'that', 'to', 'of', 'in', 'on'].includes(word.toLowerCase()));
    const candidate = content[content.length - 1];
    if (!candidate) continue;
    const cleaned = candidate.replace(/[^A-Za-z-]/g, '').toLowerCase();
    if (cleaned.length < 3 || NOT_A_DOMAIN_NOUN.has(cleaned)) continue;
    if (PRODUCTION_VERB.test(cleaned)) continue;
    found.push(cleaned);
  }
  return [...new Set(found)];
}

/** The sentences that state a rule. These name domain objects; marketing does not. */
const NORMATIVE_SENTENCE =
  /\b(must|never|only|cannot|can ?not|always|at most|at least|no more than|shall|requires?|refuses?|rejects?)\b/i;

/**
 * Participles and gerunds read as modifiers ("upcoming appointments", "matching
 * records"). They are already vetoed when unanchored; anchored ones need demoting
 * too, or "the upcoming" becomes the product's noun.
 */
const PARTICIPLE = /(?:ing|ed)$/;

/**
 * Determiners: a word right after one of these is a noun with high probability.
 * Up to three pre-nominal modifiers (including hyphenated compound modifiers like
 * "multi-tenant", "cross-border", "append-only") are skipped so "an append-only
 * customs audit log" anchors "customs" rather than "append-only", while known nouns
 * like "participant" in "a participant exercises" stop immediately on the noun.
 */
const DETERMINER = String.raw`(?:the|a|an|each|every|any|no|some|their|its|our|your|his|her|this|these|those)`;
const ADJ_MODIFIER = /(?:al|ive|ous|able|ible|ary|est|ish|less|ful|ent|ant|ic)$/;
const COMPOUND_MODIFIER =
  /^(?:multi|cross|inter|intra|trans|per|sub|non|anti|semi|quasi|pseudo|out-of|end-to|up-to|day-to|one-to|many-to|peer-to|face-to|at-least|exactly|in-memory|on-premise|on-premises|on-demand|real-time|near-real-time|day-late|full-time|part-time|long-term|short-term|high-volume|low-latency|high-availability|zero-downtime|zero-trust|single-tenant|single-page|first-party|second-party|third-party|two-person|two-factor|two-step|four-eyes|server-side|client-side|edge-side|row-level|object-level|field-level|tenant-level|fine-grained|coarse-grained)-[a-z0-9-]+$|-[a-z0-9-]*(?:only|based|backed|driven|aware|safe|free|ready|first|friendly|specific|wide|scoped|bound|capped|facing|oriented|centric|native|agnostic|tolerant|compliant|resistant|proof|locked|guarded)$/;
const DET_CHAIN = new RegExp(
  String.raw`\b${DETERMINER}((?:\s+[a-z][a-z0-9-]{3,}){1,4})`,
  'gi'
);

const INVARIANT_S_NOUN =
  /\b(series|species|customs|goods|savings|earnings|holdings|proceedings|means|(?:logist|analyt|econom|diagnost|telemat|biometr|genom|avion|forens|pediatr|geriatr|psychiatr|robot|semant|mathemat|phys|eth|polit)ics)$/;

const SINGULAR_RULES = [
  [INVARIANT_S_NOUN, null],
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
  if (INVARIANT_S_NOUN.test(word)) return word;
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

function isModifierToken(word) {
  if (COMPOUND_MODIFIER.test(word)) return true;
  if (isKnownNoun(word)) return false;
  return ADJECTIVE_WORDS.has(word) || ADJ_MODIFIER.test(word);
}

function scoreCandidates(text) {
  const words = String(text ?? '').toLowerCase();
  const tokens = words.split(/[^a-z0-9-]+/).filter((token) => token.length >= 4 && !/^\d+$/.test(token));
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

  // Domain objects are named in the sentences that state a rule. Marketing prose
  // ("a beautiful platform for modern clinics") is where the packaging noun lives.
  const normativeTokens = new Set();
  for (const sentence of words.split(/(?<=[.!?;])\s+/)) {
    if (!NORMATIVE_SENTENCE.test(sentence)) continue;
    for (const token of sentence.split(/[^a-z0-9-]+/)) if (token.length >= 4) normativeTokens.add(token);
  }

  // The opening sentences describe what the product *is*; later ones state rules and
  // constraints. That is where its domain object is named, and it is the only
  // positional signal available without a parser. Without it, "a message" in a
  // constraint sentence outscored "an appointment" in the description sentence.
  const openingTokens = new Set();
  for (const sentence of words.split(/(?<=[.!?;])\s+/).slice(0, 2)) {
    for (const token of sentence.split(/[^a-z0-9-]+/)) if (token.length >= 4) openingTokens.add(token);
  }

  const anchored = new Set();
  // Words that only look like heads: they sit directly before the packaging noun
  // ("telehealth platform"), so the head of that phrase is the abstraction, not them.
  const demotedModifiers = new Set();
  for (const match of words.matchAll(DET_CHAIN)) {
    const chain = match[1].trim().split(/\s+/).map((w) => w.toLowerCase());
    let idx = 0;
    while (idx < chain.length - 1 && isModifierToken(chain[idx])) idx += 1;
    const chosen = chain[idx];
    // A word directly in front of the packaging noun is its modifier. Check the
    // whole chain, not just the head: in "a booking app for gyms" the modifier is
    // the head because `app` was filtered, and in "a telehealth platform" it is the
    // same shape.
    // The head itself is the modifier when the packaging word that followed it was
    // filtered out of the chain ("a booking app" -> chain is just [booking]).
    if (idx === chain.length - 1) {
      const after = words.slice(match.index + match[0].length).match(/^\s+([a-z][a-z0-9-]+)/);
      if (after && ABSTRACT_SOFTWARE_NOUNS.has(after[1])) demotedModifiers.add(chosen);
    }
    if (ABSTRACT_SOFTWARE_NOUNS.has(chain[idx + 1])) demotedModifiers.add(chosen);
    for (const word of chain) {
      const position = chain.indexOf(word);
      if (position + 1 < chain.length && ABSTRACT_SOFTWARE_NOUNS.has(chain[position + 1])) demotedModifiers.add(word);
    }
    // Locate exact offset after `chosen` inside `words` to detect possessives ("the customer's order").
    let cursor = match.index + match[0].length - match[1].length;
    for (let i = 0; i <= idx; i += 1) {
      const nextPos = words.indexOf(chain[i], cursor);
      if (nextPos === -1) break;
      cursor = nextPos + chain[i].length;
    }
    if (words.slice(cursor, cursor + 2) === "'s") {
      const afterPossessive = words.slice(cursor + 2).match(/^\s+([a-z][a-z0-9-]{3,})/);
      if (afterPossessive && !isModifierToken(afterPossessive[1])) anchored.add(afterPossessive[1]);
    } else if (!COMPOUND_MODIFIER.test(chosen)) {
      anchored.add(chosen);
    }
  }

  // Collapse singular/plural (and German -en plurals) BEFORE computing repetition and
  // anchor scores, so "a claim" (1x, anchored) + "claims" (2x) earns both its anchor
  // and its 3x repetition instead of losing to a 1x hyphenated failure term like
  // "double-disbursement".
  const groups = new Map();
  for (const [token, count] of counts) {
    if (NEVER_A_NOUN.has(token) || ABSTRACT.has(token) || ADJECTIVE_WORDS.has(token)) continue;
    if (COMPOUND_MODIFIER.test(token)) continue;
    if (/^\d+$/.test(token)) continue;
    if (/ed$/.test(token)) continue;
    const isAnchor = anchored.has(token);
    const knownNoun = isKnownNoun(token);
    if (VERBISH.test(token) && !isAnchor) continue;
    if (ADJECTIVE.test(token) && !knownNoun) continue;
    // "telehealth" in "a telehealth platform" is a domain adjective. Without this
    // the anchor bonus and the score floor kept promoting it over the clinic the
    // idea actually talks about.
    if (demotedModifiers.has(token) && !knownNoun && !NOUN_SUFFIX.test(token)) continue;
    // An outcome noun mentioned in passing is not the product's object. A plain
    // plural counts as a mention: "orders" is a thing, "failures" is a report on
    // something that went wrong.
    if (ABSTRACT_OUTCOME.test(token) && !knownNoun && !isAnchor && count < 2) continue;
    // "upcoming", "matching", "scheduled": a participle with no noun evidence is
    // describing a noun, not being one. The ubiquitous-language table used to list
    // "upcoming" as one of the product's things.
    if (PARTICIPLE.test(token) && !knownNoun && !NOUN_SUFFIX.test(token) && !isAnchor) continue;


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
        nonEnglishNoun: NON_ENGLISH_NOUN.test(token),
        demoted: demotedModifiers.has(token) || demotedModifiers.has(canonical),
        normative: normativeTokens.has(token),
        opening: openingTokens.has(token)
      });
    } else {
      prev.count += count;
      prev.anchored = prev.anchored || isAnchor;
      prev.knownNoun = prev.knownNoun || knownNoun;
      prev.nounSuffix = prev.nounSuffix || NOUN_SUFFIX.test(token) || NOUN_SUFFIX.test(canonical);
      prev.nonEnglishNoun = prev.nonEnglishNoun || NON_ENGLISH_NOUN.test(token);
      prev.rawTokens.push(token);
      prev.demoted = prev.demoted || demotedModifiers.has(token);
      prev.normative = prev.normative || normativeTokens.has(token);
      prev.opening = prev.opening || openingTokens.has(token);
    }
  }

  const scored = [];
  for (const entry of groups.values()) {
    const { word, count, anchored: isAnchor, knownNoun, nounSuffix, nonEnglishNoun, demoted, normative, opening } = entry;
    const hyphenated = word.includes('-');
    let score = 0;
    if (isAnchor) score += 3;
    // A modifier in front of the packaging noun is evidence *against* being the
    // product's noun: "telehealth platform" is a kind of platform, not a kind of
    // telehealth. Subtracting rather than skipping keeps the word available when
    // the idea genuinely has nothing else.
    // Two or more, not one: "telehealth" deserves the demotion, but "appointment"
    // is a genuine domain object that happens to sit before a human noun
    // ("an appointment for a patient"). Demoting any modifier preceding a
    // software word cost the carepath packet its correct noun.
    // A modifier of the packaging noun is demoted whether or not it looks like a
    // noun: `booking` in "a booking app" is the product's activity, not its object.
    if (demoted && !ABSTRACT_SOFTWARE_NOUNS.has(word)) score -= 3;
    if (nounSuffix || knownNoun) score += 2;
    if (nonEnglishNoun) score += 2;
    if (count > 1) score += 1;
    if (count >= 3) score += 1;
    // Being named in a rule is evidence that a word belongs to the domain rather
    // than the pitch — but only when the word could be a thing. Awarding it
    // unconditionally promoted `message` and `human` over the anchored, enumerated
    // domain object `appointment`, and a packet then said "one message goes from
    // created to finished".
    if (normative && (nounSuffix || knownNoun || isAnchor || count > 1)) score += 1;
    if (opening) score += 2;
    // Hyphenated terms ("double-entry", "dead-letter") are great glossary candidates,
    // so give +1 when anchored or repeated, not on a 1x unanchored negative ("double-disbursement").
    if (hyphenated && (isAnchor || count > 1)) score += 1;
    if (!hyphenated && word.length >= 7) score += 1;
    if (!isAnchor && count < 2 && !nounSuffix && !nonEnglishNoun && !knownNoun && !demoted) score = 1;
    scored.push({ word, count, score, anchored: isAnchor, demoted: Boolean(demoted) });
  }

  // On a tie, the longer word is the more specific one ("order" over "copy",
  // "inventory" over "sync"), which is the opposite of the previous tiebreak.
  return scored.sort(
    (a, b) => b.score - a.score || b.count - a.count || b.word.length - a.word.length
  );
}

/**
 * The tenant noun: who the isolated parties are.
 *
 * "Multi-tenant" describes the architecture; the idea names the organisation. In a
 * telehealth product that is a clinic, and "two patients in different tenants" is
 * the sentence a two-slot template produced instead.
 */
const TENANT_HINT = /\b(?:for|to|across|within)\s+(?:small\s+|large\s+)?([a-z][a-z0-9-]{3,})\b/gi;
const ORG_NOUN = new Set([
  'clinic', 'hospital', 'practice', 'school', 'team', 'company', 'organisation', 'organization',
  'agency', 'bank', 'store', 'shop', 'restaurant', 'firm', 'department', 'studio', 'gym',
  'pharmacy', 'university', 'charity', 'workspace', 'account', 'tenant', 'workshop'
]);

function tenantNounFor(profile, candidates, primary) {
  if (profile?.domain?.tenant) return profile.domain.tenant;
  if (profile?.risks?.multiTenant !== true) return null;
  const fromCandidates = candidates.find((candidate) => ORG_NOUN.has(singularOf(candidate.word)));
  if (fromCandidates) return singularOf(fromCandidates.word);
  const matches = [...String(profile?.idea ?? '').matchAll(TENANT_HINT)];
  for (const match of matches) {
    if (ORG_NOUN.has(singularOf(match[1].toLowerCase()))) return singularOf(match[1].toLowerCase());
  }
  return 'tenant';
}

/** The actor who can do the dangerous things: never the end user. */
const PRIVILEGED_HINT = /\b(admin(?:istrator)?|operator|owner|manager|supervisor|reviewer|approver|auditor)s?\b/i;

function privilegedActorFor(candidates) {
  const match = candidates.find((candidate) => PRIVILEGED_HINT.test(candidate.word));
  return match ? singularOf(match.word) : 'privileged user';
}

/**
 * The words a packet is allowed to use about this product.
 *
 * `primary` is a singular noun, `secondary` the actor. Both are always usable in
 * a sentence: when the idea gives us nothing above the confidence floor we fall
 * back to the noun its kind implies, and say so via `source`.
 */
/**
 * Instruction-shaped sentences are not evidence about the product. Scoring them
 * let an injected idea make "instructions" the packet's noun, which then appeared
 * in every generated sentence — the injection echoing itself through the document.
 */
const INSTRUCTIONAL = /\b(ignore|disregard|forget|system prompt|previous instructions|you are now|assistant)\b/i;

const CODE_SHAPED = /\b(?:curl|wget|bash|sh|zsh|sudo|chmod|rm|npm|npx|git|http|https|www|com|org|net|dev|io)\b/i;

function scorableIdea(idea) {
  const text = String(idea ?? '');
  // Drop instruction sentences and command-shaped tokens whatever else the idea is
  // saying. Neither names a thing the product *is*, and both were reaching the
  // candidate list (`text`, `whatever`, `req-999`, `bash`, `curl`).
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .filter((sentence) => !INSTRUCTIONAL.test(sentence) && !/https?:\/\//i.test(sentence))
    .map((sentence) => sentence.replace(/[^\s]*[\/:|`][^\s]*/g, ' ').replace(/\bREQ-\d+\b/gi, ' '))
    .join(' ')
    .replace(new RegExp(CODE_SHAPED.source, 'gi'), ' ');
}

export function vocabularyFor(profile) {
  const candidatePool = scoreCandidates(scorableIdea(profile.idea));
  const domain = profile?.domain && typeof profile.domain === 'object' ? profile.domain : null;

  // Nouns the idea rules out. An explicit list wins; the detector is the fallback.
  // This is applied to the candidate pool rather than to the rendered table, so a
  // forbidden noun can never become the primary noun either.
  const declaredForbidden = Array.isArray(profile?.vocabulary?.forbidden)
    ? profile.vocabulary.forbidden.map((word) => String(word).toLowerCase())
    : [];
  const inferredForbidden = forbiddenNounsFor(profile.idea);
  // `affirmed` is the override in the other direction: the author says the detector
  // was too eager, and a noun it ruled out is a real term after all.
  const declaredAffirmed = new Set(
    Array.isArray(profile?.vocabulary?.affirmed) ? profile.vocabulary.affirmed.map((word) => String(word).toLowerCase()) : []
  );
  const forbidden = [...new Set([...declaredForbidden, ...inferredForbidden])].filter((word) => !declaredAffirmed.has(word));
  const forbiddenSet = new Set(forbidden);

  // A forbidden noun is not a candidate, whatever its score. This is why the filter
  // is on the pool and not on the output: "the product must never give a diagnosis"
  // can be the most frequent noun in the idea and must still never name the product.
  const allowedPool = candidatePool.filter((candidate) => !forbiddenSet.has(singularOf(candidate.word).toLowerCase()));

  // An explicit `domain` block beats inference. The noun picker exists to remove
  // the author's choice, not to overrule it: when someone writes `entity: "visit"`
  // the packet says "visit" even if the idea repeats "telehealth" twelve times.
  if (domain?.entity) {
    const entity = domain.entity;
    const entityPlural = domain.entityPlural ?? pluralOf(entity);
    const endUser = domain.endUser ?? domain.actors?.[0] ?? allowedPool.find((candidate) => isActorWord(candidate.word))?.word ?? 'user';
    const actor = domain.actors?.find((name) => singularOf(name) !== singularOf(entity)) ?? endUser;
    return {
      primary: entity,
      primaryPlural: entityPlural,
      aPrimary: `${articleFor(entity)} ${entity}`,
      secondary: actor,
      secondaryPlural: pluralOf(actor),
      secondarySource: 'domain',
      source: 'domain',
      tenantNoun: domain.tenant ?? null,
      endUser,
      privilegedActor: domain.privilegedActor ?? null,
      forbidden,
      candidates: allowedPool.slice(0, 6).map((candidate) => ({ word: singularOf(candidate.word), count: candidate.count }))
    };
  }

  const candidates = allowedPool;
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
  // A candidate may name the product only if it cleared the confidence floor. The
  // old fallback took the highest-scoring leftover whatever its score, so "An app
  // for booking" gave the noun `booking` — a word the determiner pass had
  // explicitly rejected as a modifier. An idea with no determiner at all ("Inventory
  // sync.") still has one plausible noun, and that is what `weak` is for.
  const primaryPool = confident.length > 0 ? confident : candidates.filter((candidate) => !candidate.demoted);
  // The product's noun is the thing acted upon, not the actor. Prefer any
  // non-actor noun, then the best candidate of any kind, and only then an actor:
  // "A telehealth platform where patients book visits with clinicians" must name
  // the visit, not the patient who books it.
  const nonActorPool = [...confident, ...candidates].filter((candidate) => !candidate.demoted && !isActorWord(candidate.word));
  const topObject = nonActorPool[0] ?? null;
  // An actor is the fallback only when the idea names nothing else: `patient` is a
  // person in every sentence it appears in, and a packet whose noun is a person
  // talks about the user instead of the product.
  const actorFallback = primaryPool.find((candidate) => isActorWord(candidate.word)) ?? primaryPool[0] ?? null;
  const primaryPick = topObject ?? actorFallback;
  // BUG-1 step 5 of the review: a weak pick that is not a *thing* is a guess, not a
  // decision. "Something nice for people who like things" used to yield the
  // adjective `nice`, which rendered as "One nice goes from created to finished" in
  // every template. The kind's neutral noun is more useful than a wrong one — but a
  // genuine noun the idea happened to write without a determiner ("Inventory sync")
  // must survive, so the test is the word's shape, not its score.
  const weak = confident.length === 0;
  const weakNotAThing =
    weak &&
    primaryPick !== null &&
    !isActorWord(primaryPick.word) &&
    (isModifierToken(primaryPick.word) || PARTICIPLE.test(primaryPick.word) || ABSTRACT_OUTCOME.test(primaryPick.word));
  const primary = primaryPick && !weakNotAThing ? singularOf(primaryPick.word) : fallback[0];
  // Below the confidence floor we do not guess. The old fallback took the next
  // candidate whatever its score, which is how "A platform to manage medical
  // appointments" produced the actor `manage` and a CLI idea produced `compress`:
  // a verb rendered into every sentence that needed a person.
  //
  // A recognised actor noun is different: `clinic`, `clinician` and `patient` are
  // never verbs, so domain evidence about a person or an organisation is a safe
  // pick even without a determiner. Everything else has to clear the floor.
  const actorCandidates = [...confident, ...candidates].filter(
    (candidate) => singularOf(candidate.word) !== primary && isActorWord(candidate.word)
  );
  const restPool = confident.filter((candidate) => singularOf(candidate.word) !== primary);
  const topActor = actorCandidates[0] ?? null;
  const secondaryPick = topActor ?? restPool[0] ?? null;
  const secondary = secondaryPick ? singularOf(secondaryPick.word) : fallback[1];
  const source = primary !== fallback[0] && primaryPick ? (weak ? 'weak' : 'idea') : 'kind';

  return {
    primary,
    primaryPlural: pluralOf(primary),
    aPrimary: `${articleFor(primary)} ${primary}`,
    secondary,
    secondaryPlural: pluralOf(secondary),
    secondarySource: secondaryPick?.word ?? null,
    // Role-shaped slots. Templates need a tenant noun and a privileged actor that
    // are not the end user: "privileged changes are attributable to the patient"
    // was what a two-slot vocabulary produced.
    tenantNoun: tenantNounFor(profile, candidates, primary),
    endUser: secondary,
    privilegedActor: privilegedActorFor(candidates),
    // Did we name the product, guess, or fall back to what its kind implies?
    source,
    // Candidates are singular: the ubiquitous-language table lists *things*, and
    // "bookings" next to "booking" is the synonym problem the table exists to stop.
    // Stated explicitly: a reader must be able to see what was ruled out, so a
    // wrong classification is visible rather than silent.
    forbidden,
    candidates: candidates.slice(0, 6).map((candidate) => ({ word: singularOf(candidate.word), count: candidate.count }))
  };
}

/** Candidate nouns for the ubiquitous-language table: candidates, not conclusions. */
export function ideaNouns(profile, limit = 6) {
  return vocabularyFor(profile).candidates.slice(0, limit);
}
