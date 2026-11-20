/**
 * Deterministic cross-rule contradiction, physical latency-floor, and
 * duplicate/subsumption checker (roadmap P1.3).
 *
 * Parses custom rules (and optional catalog requirements) into structured EARS
 * tuples `{ subject, modal, predicate, object, quantity, unit, comparator, negated }`
 * and flags:
 *   1. Pairwise contradictions (`REQ-C01 ⟂ REQ-C02`): retention vs immediate
 *      deletion, immutability vs mutation/deletion, stateless/no-storage vs
 *      retention/storage, offline/no-network vs synchronous external calls,
 *      anonymous/public vs mandatory authentication, plaintext vs mandatory
 *      encryption, instant/auto-approval vs mandatory manual/dual approval,
 *      same-(subject, predicate) opposite polarity, and disjoint numeric bounds
 *      (`max < min` or `eq_a !== eq_b` on the same subject + predicate + unit).
 *   2. Physically or architecturally infeasible latency floors:
 *      - LLM / AI model invocation on critical path: floor >= 200 ms
 *      - Cross-region / multi-region synchronous replication: floor >= 60 ms
 *      - Payment rail / card network / bank settlement round-trip: floor >= 1000 ms
 *      - Synchronous external third-party HTTP/API call: floor >= 25 ms
 *   3. Exact/near duplicate rules and strict numeric subsumption (warnings).
 *
 * Explicit resolutions in `profile.conflicts: [{ rules: [a, b], winner, reason }]`
 * move a contradiction from `unresolved` (blocking) to `resolved` (audited).
 *
 * Purity contract: zero runtime imports, deterministic output, safe in Core.
 */

export const LATENCY_FLOORS_MS = Object.freeze({
  ai: { floorMs: 200, label: 'AI / LLM inference call (>= 200ms floor)' },
  crossRegion: { floorMs: 60, label: 'cross-region synchronous replication (>= 60ms floor)' },
  paymentRails: { floorMs: 1000, label: 'external payment rails round-trip (>= 1000ms floor)' },
  externalApi: { floorMs: 25, label: 'synchronous external third-party API call (>= 25ms floor)' }
});

const UNIT_CONVERSIONS = Object.freeze({
  // Time -> milliseconds ('ms')
  ns: { family: 'time', factor: 0.000001 },
  nanosecond: { family: 'time', factor: 0.000001 },
  nanoseconds: { family: 'time', factor: 0.000001 },
  us: { family: 'time', factor: 0.001 },
  microsecond: { family: 'time', factor: 0.001 },
  microseconds: { family: 'time', factor: 0.001 },
  ms: { family: 'time', factor: 1 },
  millisecond: { family: 'time', factor: 1 },
  milliseconds: { family: 'time', factor: 1 },
  s: { family: 'time', factor: 1000 },
  sec: { family: 'time', factor: 1000 },
  secs: { family: 'time', factor: 1000 },
  second: { family: 'time', factor: 1000 },
  seconds: { family: 'time', factor: 1000 },
  min: { family: 'time', factor: 60_000 },
  mins: { family: 'time', factor: 60_000 },
  minute: { family: 'time', factor: 60_000 },
  minutes: { family: 'time', factor: 60_000 },
  hr: { family: 'time', factor: 3_600_000 },
  hrs: { family: 'time', factor: 3_600_000 },
  hour: { family: 'time', factor: 3_600_000 },
  hours: { family: 'time', factor: 3_600_000 },
  day: { family: 'time', factor: 86_400_000 },
  days: { family: 'time', factor: 86_400_000 },
  week: { family: 'time', factor: 604_800_000 },
  weeks: { family: 'time', factor: 604_800_000 },
  month: { family: 'time', factor: 2_592_000_000 },
  months: { family: 'time', factor: 2_592_000_000 },
  year: { family: 'time', factor: 31_536_000_000 },
  years: { family: 'time', factor: 31_536_000_000 },
  // Size -> bytes
  b: { family: 'size', factor: 1 },
  byte: { family: 'size', factor: 1 },
  bytes: { family: 'size', factor: 1 },
  kb: { family: 'size', factor: 1024 },
  kilobyte: { family: 'size', factor: 1024 },
  kilobytes: { family: 'size', factor: 1024 },
  mb: { family: 'size', factor: 1024 * 1024 },
  megabyte: { family: 'size', factor: 1024 * 1024 },
  megabytes: { family: 'size', factor: 1024 * 1024 },
  gb: { family: 'size', factor: 1024 * 1024 * 1024 },
  gigabyte: { family: 'size', factor: 1024 * 1024 * 1024 },
  gigabytes: { family: 'size', factor: 1024 * 1024 * 1024 },
  // Length / count / currency / percent
  char: { family: 'chars', factor: 1 },
  chars: { family: 'chars', factor: 1 },
  character: { family: 'chars', factor: 1 },
  characters: { family: 'chars', factor: 1 },
  retry: { family: 'retries', factor: 1 },
  retries: { family: 'retries', factor: 1 },
  attempt: { family: 'attempts', factor: 1 },
  attempts: { family: 'attempts', factor: 1 },
  time: { family: 'retries', factor: 1 },
  times: { family: 'retries', factor: 1 },
  session: { family: 'sessions', factor: 1 },
  sessions: { family: 'sessions', factor: 1 },
  request: { family: 'requests', factor: 1 },
  requests: { family: 'requests', factor: 1 },
  rps: { family: 'rps', factor: 1 },
  '%': { family: 'percent', factor: 1 },
  percent: { family: 'percent', factor: 1 },
  usd: { family: 'currency', factor: 1 },
  dollar: { family: 'currency', factor: 1 },
  dollars: { family: 'currency', factor: 1 },
  eur: { family: 'currency', factor: 1 },
  gbp: { family: 'currency', factor: 1 }
});

const PREDICATE_CLASSES = [
  ['delete', /\b(?:delet(?:e|es|ed|ing)|eras(?:e|es|ed|ing)|purg(?:e|es|ed|ing)|wip(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|destroy(?:s|ed|ing)?|drop(?:s|ped|ping)?)\b/i],
  ['retain', /\b(?:retain(?:s|ed|ing)?|keep(?:s|ing)?|kept|preserv(?:e|es|ed|ing)|archiv(?:e|es|ed|ing)|hold(?:s|ing)?\s+for|stored?\s+for|retention)\b/i],
  ['mutate', /\b(?:modif(?:y|ies|ied)|edit(?:s|ed|ing)?|updat(?:e|es|ed|ing)|overwrite(?:s|n)?|mutat(?:e|es|ed|ing)|alter(?:s|ed)?)\b/i],
  ['respond', /\b(?:respond(?:s|ed|ing)?|complet(?:e|es|ed|ing)|return(?:s|ed|ing)?|serv(?:e|es|ed)|finish(?:es|ed)?|settl(?:e|es|ed)|replicat(?:e|es|ed)|latency|p99|p95|response\s+time|timeout|time\s*out)\b/i],
  ['expire', /\b(?:expir(?:e|es|ed|ing)|remain\s+(?:active|valid)|stay\s+(?:signed|logged)\s+in|session\s+(?:lifetime|duration|ttl)|ttl|invalidat(?:e|es|ed))\b/i],
  ['retry', /\b(?:retr(?:y|ies|ied|ying)|re-?attempt(?:s|ed)?)\b/i],
  ['lockout', /\b(?:lock(?:s|ed|ing)?(?:\s+out)?|failed\s+(?:login|sign-?in|auth)\s+attempts?)\b/i],
  ['upload', /\b(?:upload(?:s|ed|ing)?|file\s+size|payload\s+size|attachment(?:s)?|body\s+size)\b/i],
  ['password', /\b(?:password(?:s)?|passphrase(?:s)?)\b/i],
  ['session', /\b(?:concurrent\s+sessions?|active\s+sessions?|simultaneous\s+(?:logins?|sessions?))\b/i],
  ['authenticate', /\b(?:authenticat(?:e|es|ed|ion)|sign[- ]?in|log[- ]?in|mfa|two[- ]?factor|2fa|bearer\s+token|api\s+key|login)\b/i],
  ['encrypt', /\b(?:encrypt(?:s|ed|ing|ion)?|tls|ciphertext|aes|kms)\b/i],
  ['approve', /\b(?:approv(?:e|es|ed|al)|review(?:s|ed)?|sign[- ]?off|dual\s+control|two[- ]?person|human[- ]in[- ]the[- ]loop)\b/i],
  ['share', /\b(?:shar(?:e|es|ed|ing)|export(?:s|ed|ing)?|sell(?:s|ing)?|transmit(?:s|ted)?|send(?:s|ing)?|forward(?:s|ed)?)\b/i],
  ['network', /\b(?:network|internet|offline|air[- ]?gapped|external\s+(?:api|service|http|call)|outbound\s+(?:http|request|call)|webhook|sync(?:s|ed|ing)?)\b/i],
  ['store', /\b(?:stor(?:e|es|ed|ing|age)|persist(?:s|ed|ing|ence)?|sav(?:e|es|ed|ing)|record(?:s|ed|ing)?|log(?:s|ged|ging)?|write(?:s|ing)?|collect(?:s|ed|ing)?)\b/i],
  ['allow', /\b(?:allow(?:s|ed|ing)?|permit(?:s|ted|ting)?|accept(?:s|ed|ing)?|enable(?:s|d)?|grant(?:s|ed)?|access)\b/i]
];

const SUBJECT_CLASSES = [
  ['password', /\b(?:password|passphrase)s?\b/i],
  ['session', /\b(?:session|token|jwt|cookie)s?\b/i],
  ['upload', /\b(?:upload|attachment|file|payload|request\s+body)s?\b/i],
  ['webhook', /\b(?:webhook|callback)s?\b/i],
  ['refund', /\b(?:refund|chargeback|reimbursement)s?\b/i],
  ['payout', /\b(?:payout|disbursement|withdrawal|transfer|wire|settlement|payment|charge|transaction|invoice)s?\b/i],
  ['audit-log', /\b(?:audit\s+(?:log|trail|entry|record)s?|ledger(?:\s+entr(?:y|ies))?)\b/i],
  ['log', /\b(?:log|telemetry|trace|event)s?\b/i],
  ['pii', /\b(?:personal\s+(?:data|information)|pii|phi|user\s+data|customer\s+data|patient\s+(?:data|records?)|profile\s+data)\b/i],
  ['account', /\b(?:account|user|member|tenant|profile)s?\b/i],
  ['endpoint', /\b(?:endpoint|route|api(?:\s+call|\s+request)?|request|call|query)s?\b/i],
  ['export', /\b(?:export|backup|snapshot|report|csv)s?\b/i],
  ['deployment', /\b(?:deployment|deploy|release|migration|pull\s+request)s?\b/i],
  ['data', /\b(?:data|record|row|document|item|entit(?:y|ies)|message|note)s?\b/i]
];

const NEGATION_RE = /\b(?:shall\s+not|shall\s+never|must\s+not|must\s+never|may\s+not|cannot|can\s+never|never|forbid(?:s|den)?|prohibit(?:s|ed)?|disallow(?:s|ed)?|deny|denies|denied|reject(?:s|ed)?|refus(?:e|es|ed)|block(?:s|ed)?|no\s+(?:data|records?|logs?|pii|personal|network|external|retries|retry|human|manual|authentication|login|encryption|storage|persistence|exports?|sharing|anonymous|unauthenticated)|zero\s+(?:retries|storage|persistence|retention|data|network)|without\s+(?:authentication|login|approval|review|encryption|retries|storing|network)|stateless|immutable|append[- ]only|read[- ]only|offline[- ]only|air[- ]gapped)\b/i;

const CARVEOUT_RE = /\b(?:except|unless|excluding|other\s+than|subject\s+to|where\s+no\s+legal\s+hold|save\s+for|non[- ](?:financial|audit|ledger|regulated)|outside\s+of|after\s+(?:retention|expiry|7\s+years))\b/i;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'by', 'at', 'from', 'as', 'is', 'are', 'be',
  'been', 'being', 'that', 'this', 'all', 'any', 'every', 'each', 'shall', 'must', 'should', 'will', 'can', 'may',
  'when', 'while', 'where', 'if', 'then', 'application', 'system', 'service', 'product', 'enforce', 'evaluating',
  'domain', 'rules', 'its', 'their', 'it'
]);

/** Extract numeric quantity, canonical unit, normalized value, and comparator. */
function extractQuantity(text) {
  // Handle currency prefix `$500` first only if no time/size/count bound exists.
  const unitNames = Object.keys(UNIT_CONVERSIONS)
    .filter((u) => u !== '%')
    .sort((a, b) => b.length - a.length)
    .join('|');
  const re = new RegExp(
    `(?:(<=|>=|<|>|=|at\\s+most|no\\s+more\\s+than|within|under|less\\s+than|fewer\\s+than|max(?:imum)?(?:\\s+of)?|up\\s+to|at\\s+least|no\\s+(?:less|fewer)\\s+than|minimum(?:\\s+of)?|more\\s+than|over|greater\\s+than|exceeds?|longer\\s+than|for\\s+at\\s+least|for\\s+at\\s+most|for|exactly|after)\\s+)?(\\d+(?:\\.\\d+)?)\\s*(?:(?:concurrent|active|failed|simultaneous|consecutive|total|separate)\\s+)?(%|${unitNames})(?![a-z])`,
    'gi'
  );

  const matches = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const rawComp = (m[1] ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    const rawQty = Number(m[2]);
    const rawUnit = m[3].toLowerCase();
    const conv = UNIT_CONVERSIONS[rawUnit];
    if (!conv || !Number.isFinite(rawQty)) continue;

    let comparator = 'eq';
    if (/^(?:<=|at most|no more than|within|under|max|maximum|maximum of|up to|for at most)$/.test(rawComp)) {
      comparator = 'lte';
    } else if (/^(?:<|less than|fewer than)$/.test(rawComp)) {
      comparator = 'lt';
    } else if (/^(?:>=|at least|no less than|no fewer than|minimum|minimum of|for at least)$/.test(rawComp)) {
      comparator = 'gte';
    } else if (/^(?:>|more than|over|greater than|exceeds|exceed|longer than)$/.test(rawComp)) {
      comparator = 'gt';
    } else if (rawComp === 'for' && conv.family === 'time') {
      // "retain records for 7 years" sets a minimum retention horizon.
      comparator = /\b(?:retain|keep|kept|preserv|hold|store|remain|active|valid)\b/i.test(text) ? 'gte' : 'eq';
    } else if (rawComp === 'after' && /\b(?:expir|timeout|time\s*out|delet|purg|invalidat)\b/i.test(text)) {
      comparator = 'lte';
    }

    // Check whether this numeric phrase is merely a trigger condition ("When refunds over $500...").
    const prefix = text.slice(0, m.index);
    const isTriggerGuard = /\b(?:when|if|for)\s+[^,]{0,35}$/i.test(prefix) && text.slice(m.index).includes(',');

    matches.push({
      quantity: rawQty,
      unit: rawUnit,
      family: conv.family,
      normalizedValue: rawQty * conv.factor,
      comparator,
      isTriggerGuard
    });
  }

  // Prefer main-clause quantities over conditional trigger guards.
  const primary = matches.find((x) => !x.isTriggerGuard) ?? matches[0] ?? null;
  if (primary) return primary;

  const dollar = text.match(/(<=|>=|<|>|at\s+most|under|max(?:imum)?|up\s+to|at\s+least|minimum|over|above|exactly)?\s*\$\s*(\d+(?:\.\d+)?)/i);
  if (dollar) {
    const rawComp = (dollar[1] ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    const qty = Number(dollar[2]);
    let comparator = 'eq';
    if (/^(?:<=|at most|under|max|maximum|up to)$/.test(rawComp)) comparator = 'lte';
    else if (rawComp === '<') comparator = 'lt';
    else if (/^(?:>=|at least|minimum)$/.test(rawComp)) comparator = 'gte';
    else if (/^(?:>|over|above)$/.test(rawComp)) comparator = 'gt';
    return { quantity: qty, unit: 'usd', family: 'currency', normalizedValue: qty, comparator, isTriggerGuard: false };
  }

  // Zero-retry shorthand ("never retry failed webhooks").
  if (/\b(?:never\s+retr(?:y|ies)|no\s+retr(?:y|ies)|zero\s+retr(?:y|ies)|do\s+not\s+retry|shall\s+not\s+retry|must\s+not\s+retry)\b/i.test(text)) {
    return { quantity: 0, unit: 'retries', family: 'retries', normalizedValue: 0, comparator: 'lte', isTriggerGuard: false };
  }

  // Single-session shorthand ("only a single active session").
  if (/\b(?:single\s+(?:active\s+|concurrent\s+)?session|only\s+one\s+(?:active\s+|concurrent\s+)?session)\b/i.test(text)) {
    return { quantity: 1, unit: 'sessions', family: 'sessions', normalizedValue: 1, comparator: 'lte', isTriggerGuard: false };
  }

  return null;
}

/** Extract actor/state scope qualifiers that prevent false-positive contradictions. */
function extractScopeQualifier(text) {
  const scopes = [];
  if (/\b(?:guest|anonymous|unauthenticated|public\s+health\s+check|\/health)\b/i.test(text) && /\b(?:only|endpoint|route)\b/i.test(text)) {
    scopes.push('public-subset');
  }
  const roleMatch = text.match(/\b(?:for\s+)?(admin(?:istrator)?s?|guests?|viewers?|editors?|owners?|auditors?|free[- ]tier|enterprise[- ]tier|pro[- ]tier|sandbox|staging|test\s+mode)\s+only\b/i)
    ?? text.match(/^(?:when|for|while)\s+(?:an?\s+)?(admin(?:istrator)?|guest|viewer|editor|free[- ]tier|enterprise[- ]tier|staging|sandbox)\b/i);
  if (roleMatch) scopes.push(`role:${roleMatch[1].toLowerCase().replace(/s$/, '')}`);

  const tierBound = text.match(/\b(?:over|above|exceeding|under|below)\s+\$\s*(\d+)/i);
  if (tierBound) {
    const dir = /\b(?:over|above|exceeding)\b/i.test(tierBound[0]) ? 'gt' : 'lt';
    scopes.push(`amount:${dir}:${tierBound[1]}`);
  }
  return scopes.join('|') || null;
}

function contentTokens(text) {
  return [...new Set(
    String(text ?? '')
      .toLowerCase()
      .replace(/\bwhen evaluating domain rules,\s*the application shall enforce that\b/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w))
  )];
}

/**
 * Parse a requirement or rule into a structured EARS AST node:
 * `{ id, key, subject, modal, predicate, object, quantity, unit, comparator, negated, ... }`.
 */
export function parseRuleAst(req) {
  const id = req.id ?? 'REQ-C00';
  const key = req.key ?? id;
  const rawText = String(req.sourceRule ?? req.sourceRuleText ?? req.title ?? req.statement ?? '').trim();
  const statement = String(req.statement ?? rawText).trim();
  // Prefer raw user prose + EARS statement combined, stripping compiler wrapper boilerplate.
  const coreText = (req.sourceRule ?? req.sourceRuleText ?? statement)
    .replace(/^When evaluating domain rules,\s*the application shall enforce that\s+/i, '')
    .trim();

  const negated = NEGATION_RE.test(coreText);
  const modal = negated ? 'shall-not' : 'shall';

  let predicate = 'enforce';
  for (const [cls, re] of PREDICATE_CLASSES) {
    if (re.test(coreText)) {
      predicate = cls;
      break;
    }
  }

  let subject = 'application';
  for (const [cls, re] of SUBJECT_CLASSES) {
    if (re.test(coreText)) {
      subject = cls;
      break;
    }
  }

  // Extract grammatical object snippet after the primary verb when present.
  const objMatch = coreText.match(/\b(?:delete|retain|keep|store|persist|encrypt|allow|permit|require|reject|share|export|approve|log|send|accept|return|respond)\w*\s+([^,.;]{2,48})/i);
  const object = objMatch ? objMatch[1].trim().toLowerCase() : subject;

  const quant = extractQuantity(coreText);
  const tokens = contentTokens(coreText);

  // Semantic trait flags for high-precision contradiction axioms.
  const flags = {
    immediateDelete:
      /\b(?:delet(?:e|es|ed)|eras(?:e|es|ed)|purg(?:e|es|ed)|wip(?:e|es|ed)|destroy(?:s|ed)?)\b/i.test(coreText) &&
      !negated &&
      /\b(?:immediat(?:e|ely)|instant(?:ly)?|permanently|all\s+(?:user\s+|customer\s+|stored\s+|account\s+)?(?:data|records?|logs?|history)|on\s+(?:user\s+)?request|right\s+away|within\s+0|synchronously)\b/i.test(coreText),
    universalDeleteOrEdit:
      /\b(?:delet(?:e|es)|edit(?:s)?|modif(?:y|ies)|updat(?:e|es)|overwrite(?:s)?|purg(?:e|es))\b/i.test(coreText) &&
      !negated &&
      /\b(?:any|all|every|permanently|at\s+any\s+time|immediat(?:e|ely))\b/i.test(coreText),
    mandatoryRetention:
      /\b(?:retain(?:s|ed)?|keep(?:s)?|kept|preserv(?:e|es|ed)|hold(?:s)?|must\s+store|shall\s+store|never\s+delet(?:e|ed)|cannot\s+be\s+deleted|must\s+not\s+(?:be\s+)?delet(?:e|ed)|shall\s+not\s+(?:be\s+)?delet(?:e|ed))\b/i.test(coreText) &&
      !/\b(?:never\s+(?:retain|keep|store)|must\s+not\s+(?:retain|keep|store)|shall\s+not\s+(?:retain|keep|store)|do\s+not\s+(?:retain|keep|store)|zero\s+retention)\b/i.test(coreText),
    immutable:
      /\b(?:immutable|append[- ]only|never\s+(?:be\s+)?(?:deleted|modified|edited|updated|overwritten|altered)|(?:must|shall|can)\s*not\s+(?:be\s+)?(?:deleted|modified|edited|updated|overwritten|purged|erased)|read[- ]only|write[- ]once)\b/i.test(coreText),
    zeroStorage:
      /\b(?:stateless|zero\s+(?:storage|persistence|retention|data)|(?:never|must\s+not|shall\s+not|do\s+not|does\s+not)\s+(?:store|persist|save|retain|keep|log|record|collect)\s+(?:any\s+)?(?:user|customer|personal|pii|data|records?|logs?|(?:request\s+)?payloads?|history|messages?|state)|no\s+(?:data|user\s+data|personal\s+data|pii|records?|logs?|payloads?)\s+(?:is|are|shall\s+be|may\s+be)?\s*(?:stored|persisted|retained|saved|logged))\b/i.test(coreText),
    mustStore:
      /\b(?:store|stores|persist|persists|save|saves|retain|retains|archive|archives|log|logs|record|records)\b/i.test(coreText) &&
      !negated &&
      /\b(?:all|every|user|customer|personal|pii|profile|audit|request|payloads?|messages?|history|database|years?|months?|days?)\b/i.test(coreText),
    offlineNoNetwork:
      /\b(?:offline[- ]only|air[- ]gapped|zero\s+network|no\s+(?:network|internet|outbound|external\s+(?:api|http|network|calls?))|(?:never|must\s+not|shall\s+not|do\s+not|cannot)\s+(?:make|send|perform|open|call|access|connect)\s+(?:any\s+)?(?:outbound\s+|external\s+)?(?:network|internet|http|api|webhook|remote))\b/i.test(coreText),
    mustCallExternal:
      !negated &&
      /\b(?:(?:call|calls|invoke|invokes|send|sends|post|posts|log|logs|sync|syncs|forward|forwards|stream|streams|charge|charges|verify|verifies)\b[^.]{0,45}\b(?:external\s+(?:ai\s+)?api|third[- ]party\s+api|remote\s+(?:api|server|endpoint)|stripe|twilio|sendgrid|openai|anthropic|llm\s+api|webhook|cloud\s+service|in\s+real\s+time)|synchronous(?:ly)?\s+(?:call|replicate|webhook))\b/i.test(coreText),
    callsAi:
      !negated &&
      /\b(?:external\s+ai(?:\s+api)?|llm(?:\s+(?:call|api|inference|model|completion))?|ai\s+(?:model|inference|completion|api|classifier|summary|moderation)|openai|anthropic|gpt-\d|claude|language\s+model|generate(?:s)?\s+embeddings?)\b/i.test(coreText),
    crossRegionSync:
      !negated &&
      /\b(?:cross[- ]region|multi[- ]region|inter[- ]continental|global\s+(?:quorum|consensus|synchronous)|synchronous(?:ly)?\s+replicat(?:e|ed|ion)\s+across\s+regions?)\b/i.test(coreText),
    callsPaymentRail:
      !negated &&
      /\b(?:payment\s+rail|card\s+(?:network|authorization|capture|settlement)|stripe\s+(?:charge|capture|payment|api)|adyen|braintree|ach\s+(?:settlement|transfer)|wire\s+transfer|bank\s+(?:settlement|transfer|rail)|charge(?:s)?\s+(?:the\s+)?(?:credit\s+)?card\s+synchronously)\b/i.test(coreText),
    appliesToEveryRequest:
      /\b(?:every\s+(?:api\s+)?(?:call|request|endpoint|operation|query)|all\s+(?:api\s+)?(?:calls|requests|endpoints|routes)|each\s+(?:api\s+)?(?:call|request))\b/i.test(coreText),
    allowsAnonymousAll:
      !/\b(?:never|must\s+not|shall\s+not|do\s+not|cannot|forbid|prohibit)\s+(?:allow|permit|accept|support|serve)\b/i.test(coreText) &&
      /\b(?:(?:allow|permit|accept|support|serve)s?\s+(?:anonymous|unauthenticated|guest|public|passwordless\s+guest)\s+(?:access|requests?|calls?|users?|reads?|writes?)|accessible\s+without\s+(?:authentication|login|signing\s+in|an?\s+account)|no\s+(?:authentication|login|account)\s+(?:is\s+)?required)\b/i.test(coreText) &&
      !/\b(?:health\s+check|\/health|public\s+landing\s+page\s+only)\b/i.test(coreText),
    requiresAuthAll:
      /\b(?:(?:every|all|each)\s+(?:api\s+)?(?:endpoint|route|request|call|action|user|operation)s?\s+(?:must|shall|requires?)\s+(?:require\s+)?(?:authentication|authenticated|mfa|two[- ]factor|2fa|signed[- ]in|valid\s+(?:jwt|bearer|session|token))|(?:reject|deny|block|forbid|never\s+allow)s?\s+(?:all\s+|any\s+)?(?:anonymous|unauthenticated|guest)\s+(?:access|requests?|calls?|users?)|authentication\s+(?:is\s+)?required\s+for\s+(?:all|every))\b/i.test(coreText),
    requiresPlaintext:
      /\b(?:plaintext|plain[- ]text|unencrypted|cleartext|without\s+encryption|(?:must\s+not|shall\s+not|never)\s+encrypt)\b/i.test(coreText) &&
      !/\b(?:never|must\s+not|shall\s+not|forbid|prohibit|reject|no)\s+(?:store\s+|log\s+|send\s+|transmit\s+|write\s+|in\s+)?(?:plaintext|plain[- ]text|unencrypted|cleartext)\b/i.test(coreText),
    requiresEncryption:
      !negated &&
      /\b(?:(?:all|every)\s+[^.]{0,30}\bencrypt(?:ed|ion)|encrypt\s+(?:all|every)|must\s+be\s+encrypted|shall\s+be\s+encrypted|encrypted\s+at\s+rest|encrypted\s+in\s+transit)\b/i.test(coreText),
    autoNoApproval:
      /\b(?:(?:auto(?:matic(?:ally)?)?[- ]?(?:approve|disburse|execute|merge|deploy|refund|settle|process))|without\s+(?:any\s+)?(?:human|manual|admin|manager|second)\s+(?:approval|review|intervention|sign[- ]off)|no\s+(?:human|manual)\s+(?:approval|review)|instant(?:ly)?\s+(?:approve|disburse|settle|execute|refund)s?\s+(?:all|every))\b/i.test(coreText) &&
      !/\b(?:never|must\s+not|shall\s+not|cannot)\s+auto/i.test(coreText),
    requiresManualApproval:
      !negated &&
      /\b(?:(?:require|requires|must\s+have|shall\s+require)\s+(?:manual|human|dual|two[- ]person|manager|admin|compliance)\s+(?:approval|review|sign[- ]off)|human[- ]in[- ]the[- ]loop\s+approval)\b/i.test(coreText),
    forbidsSharing:
      /\b(?:(?:never|must\s+not|shall\s+not|cannot|do\s+not|forbid|prohibit)\s+(?:share|export|send|transmit|sell|disclose|expose)|no\s+(?:data\s+)?(?:export|sharing|third[- ]party\s+sharing))\b/i.test(coreText),
    requiresSharing:
      !negated &&
      /\b(?:(?:must|shall|always|automatically)\s+(?:export|share|send|transmit|publish|forward)|(?:allow|enable|provide)\s+(?:full\s+|self[- ]serve\s+)?(?:data\s+)?export(?:s)?)\b/i.test(coreText),
    hasCarveout: CARVEOUT_RE.test(coreText)
  };

  return {
    id,
    key,
    origin: req.origin ?? 'catalog',
    subject,
    modal,
    predicate,
    object,
    quantity: quant?.quantity ?? null,
    unit: quant?.unit ?? null,
    unitFamily: quant?.family ?? null,
    normalizedValue: quant?.normalizedValue ?? null,
    comparator: quant?.comparator ?? null,
    negated,
    scopeQualifier: extractScopeQualifier(coreText),
    hasCarveout: flags.hasCarveout,
    text: coreText,
    statement,
    tokens,
    flags
  };
}

function scopesDisjoint(a, b) {
  if (!a.scopeQualifier || !b.scopeQualifier) {
    // One rule is explicitly narrowed to a tiny subset (e.g. "guests only" vs "admins only").
    return false;
  }
  if (a.scopeQualifier === b.scopeQualifier) return false;
  if (a.scopeQualifier.startsWith('role:') && b.scopeQualifier.startsWith('role:')) return true;
  if (a.scopeQualifier.startsWith('amount:') && b.scopeQualifier.startsWith('amount:')) {
    const [, dirA, valA] = a.scopeQualifier.split(':');
    const [, dirB, valB] = b.scopeQualifier.split(':');
    if (dirA !== dirB && Number(valA) >= Number(valB) || dirA !== dirB && Number(valB) >= Number(valA)) return true;
  }
  return false;
}

function jaccard(tokensA, tokensB) {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  if (setA.size === 0 && setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) {
    if (setB.has(t)) inter += 1;
  }
  return inter / (setA.size + setB.size - inter);
}

function subjectsCompatible(a, b) {
  if (a.subject === b.subject) return true;
  const dataGroup = new Set(['data', 'pii', 'audit-log', 'log', 'account', 'payout', 'refund']);
  if ((a.subject === 'data' && dataGroup.has(b.subject)) || (b.subject === 'data' && dataGroup.has(a.subject))) {
    return true;
  }
  const userGroup = new Set(['pii', 'account', 'data']);
  if (userGroup.has(a.subject) && userGroup.has(b.subject)) return true;
  const moneyGroup = new Set(['payout', 'refund']);
  if (moneyGroup.has(a.subject) && moneyGroup.has(b.subject)) return true;
  return false;
}

/** Convert `{ comparator, normalizedValue }` to `[min, max]` interval. */
function toInterval(ast) {
  if (ast.normalizedValue === null || !ast.comparator) return null;
  const v = ast.normalizedValue;
  const eps = v === 0 ? 1e-9 : Math.abs(v) * 1e-9;
  switch (ast.comparator) {
    case 'lte': return { min: -Infinity, max: v };
    case 'lt': return { min: -Infinity, max: v - eps };
    case 'gte': return { min: v, max: Infinity };
    case 'gt': return { min: v + eps, max: Infinity };
    case 'eq': return { min: v, max: v };
    default: return null;
  }
}

/** Detect whether two parsed rule ASTs contradict each other; return reason or null. */
function detectPairContradiction(a, b) {
  if (scopesDisjoint(a, b)) return null;
  const carveoutExempt = a.hasCarveout || b.hasCarveout;

  // 1. Immediate deletion vs mandatory retention (Adversarial Test D).
  if (!carveoutExempt) {
    if (
      (a.flags.immediateDelete && b.flags.mandatoryRetention) ||
      (b.flags.immediateDelete && a.flags.mandatoryRetention)
    ) {
      const del = a.flags.immediateDelete ? a : b;
      const ret = a.flags.immediateDelete ? b : a;
      return `immediate deletion ("${del.text}") conflicts with mandatory retention ("${ret.text}") without a scoped hold/carve-out`;
    }

    // 2. Immutability / no-delete vs delete / edit.
    if (
      (a.flags.immutable && b.flags.universalDeleteOrEdit && subjectsCompatible(a, b)) ||
      (b.flags.immutable && a.flags.universalDeleteOrEdit && subjectsCompatible(a, b))
    ) {
      return `immutability/non-deletion rule ("${(a.flags.immutable ? a : b).text}") conflicts with mutation/deletion rule ("${(a.flags.immutable ? b : a).text}")`;
    }

    // 3. Zero storage / stateless vs mandatory storage / retention.
    if (
      (a.flags.zeroStorage && (b.flags.mustStore || b.flags.mandatoryRetention) && subjectsCompatible(a, b)) ||
      (b.flags.zeroStorage && (a.flags.mustStore || a.flags.mandatoryRetention) && subjectsCompatible(a, b))
    ) {
      return `zero-persistence prohibition ("${(a.flags.zeroStorage ? a : b).text}") conflicts with persistence/retention obligation ("${(a.flags.zeroStorage ? b : a).text}")`;
    }

    // 4. Offline / no network vs mandatory external calls.
    if (
      (a.flags.offlineNoNetwork && b.flags.mustCallExternal) ||
      (b.flags.offlineNoNetwork && a.flags.mustCallExternal)
    ) {
      return `offline/no-network rule ("${(a.flags.offlineNoNetwork ? a : b).text}") conflicts with external network obligation ("${(a.flags.offlineNoNetwork ? b : a).text}")`;
    }

    // 5. Allow anonymous access vs require authentication on all endpoints.
    if (
      (a.flags.allowsAnonymousAll && b.flags.requiresAuthAll) ||
      (b.flags.allowsAnonymousAll && a.flags.requiresAuthAll)
    ) {
      return `anonymous/unauthenticated access ("${(a.flags.allowsAnonymousAll ? a : b).text}") conflicts with mandatory authentication ("${(a.flags.allowsAnonymousAll ? b : a).text}")`;
    }

    // 6. Plaintext storage/transport vs mandatory encryption.
    if (
      (a.flags.requiresPlaintext && b.flags.requiresEncryption && subjectsCompatible(a, b)) ||
      (b.flags.requiresPlaintext && a.flags.requiresEncryption && subjectsCompatible(a, b))
    ) {
      return `plaintext requirement ("${(a.flags.requiresPlaintext ? a : b).text}") conflicts with mandatory encryption ("${(a.flags.requiresPlaintext ? b : a).text}")`;
    }

    // 7. Auto-approve with no human review vs mandatory manual/dual approval.
    if (
      (a.flags.autoNoApproval && b.flags.requiresManualApproval && (subjectsCompatible(a, b) || a.scopeQualifier === b.scopeQualifier)) ||
      (b.flags.autoNoApproval && a.flags.requiresManualApproval && (subjectsCompatible(a, b) || a.scopeQualifier === b.scopeQualifier))
    ) {
      // Only exempt when one specifies an amount threshold and the other explicitly specifies the opposite side.
      if (!a.scopeQualifier || !b.scopeQualifier || a.scopeQualifier === b.scopeQualifier) {
        return `automatic approval without human review ("${(a.flags.autoNoApproval ? a : b).text}") conflicts with mandatory manual/dual approval ("${(a.flags.autoNoApproval ? b : a).text}")`;
      }
    }

    // 8. Forbid sharing/export vs require sharing/export on compatible subjects.
    if (
      (a.flags.forbidsSharing && b.flags.requiresSharing && subjectsCompatible(a, b)) ||
      (b.flags.forbidsSharing && a.flags.requiresSharing && subjectsCompatible(a, b))
    ) {
      return `export/sharing prohibition ("${(a.flags.forbidsSharing ? a : b).text}") conflicts with mandatory export/sharing ("${(a.flags.forbidsSharing ? b : a).text}")`;
    }
  }

  // 9. Disjoint numeric intervals on the same (subject, predicate, unitFamily).
  if (
    a.unitFamily &&
    a.unitFamily === b.unitFamily &&
    a.subject === b.subject &&
    (a.predicate === b.predicate ||
      (a.unitFamily === 'retries' && b.unitFamily === 'retries') ||
      (a.unitFamily === 'sessions' && b.unitFamily === 'sessions') ||
      (a.unitFamily === 'chars' && b.unitFamily === 'chars') ||
      (a.unitFamily === 'size' && b.unitFamily === 'size'))
  ) {
    const intA = toInterval(a);
    const intB = toInterval(b);
    if (intA && intB && (intA.max < intB.min || intB.max < intA.min)) {
      return `incompatible numeric bounds on ${a.subject}/${a.predicate}: ${a.comparator} ${a.quantity} ${a.unit} vs ${b.comparator} ${b.quantity} ${b.unit}`;
    }
  }

  // 10. Direct polarity clash on same subject + predicate + high lexical overlap.
  if (
    !carveoutExempt &&
    a.negated !== b.negated &&
    a.subject !== 'application' &&
    a.subject === b.subject &&
    a.predicate !== 'enforce' &&
    a.predicate === b.predicate &&
    jaccard(a.tokens, b.tokens) >= 0.45
  ) {
    return `opposite polarity (${a.modal} vs ${b.modal}) on ${a.subject} ${a.predicate}`;
  }

  return null;
}

/** Detect duplicate or strictly subsumed rule pairs. */
function detectDuplicateOrSubsumption(a, b) {
  if (scopesDisjoint(a, b)) return null;
  const overlap = jaccard(a.tokens, b.tokens);

  if (
    a.negated === b.negated &&
    overlap >= 0.8 &&
    a.normalizedValue === b.normalizedValue &&
    a.comparator === b.comparator
  ) {
    return {
      kind: 'duplicate',
      rules: [a.id, b.id],
      label: `${a.id} ≈ ${b.id}`,
      reason: `near-duplicate rules (${Math.round(overlap * 100)}% lexical overlap): "${a.text}" vs "${b.text}"`
    };
  }

  // Strict numeric subsumption: e.g. respond <= 100ms implies respond <= 500ms;
  // password >= 16 chars implies password >= 12 chars.
  if (
    a.negated === b.negated &&
    a.subject === b.subject &&
    a.predicate === b.predicate &&
    a.unitFamily &&
    a.unitFamily === b.unitFamily &&
    a.normalizedValue !== null &&
    b.normalizedValue !== null &&
    a.normalizedValue !== b.normalizedValue &&
    overlap >= 0.45
  ) {
    const bothUpper = (a.comparator === 'lte' || a.comparator === 'lt') && (b.comparator === 'lte' || b.comparator === 'lt');
    const bothLower = (a.comparator === 'gte' || a.comparator === 'gt') && (b.comparator === 'gte' || b.comparator === 'gt');
    if (bothUpper) {
      const stronger = a.normalizedValue < b.normalizedValue ? a : b;
      const weaker = a.normalizedValue < b.normalizedValue ? b : a;
      return {
        kind: 'subsumed',
        rules: [stronger.id, weaker.id],
        stronger: stronger.id,
        subsumed: weaker.id,
        label: `${stronger.id} ⊂ ${weaker.id}`,
        reason: `${stronger.id} (${stronger.comparator} ${stronger.quantity} ${stronger.unit}) strictly subsumes ${weaker.id} (${weaker.comparator} ${weaker.quantity} ${weaker.unit})`
      };
    }
    if (bothLower) {
      const stronger = a.normalizedValue > b.normalizedValue ? a : b;
      const weaker = a.normalizedValue > b.normalizedValue ? b : a;
      return {
        kind: 'subsumed',
        rules: [stronger.id, weaker.id],
        stronger: stronger.id,
        subsumed: weaker.id,
        label: `${stronger.id} ⊂ ${weaker.id}`,
        reason: `${stronger.id} (${stronger.comparator} ${stronger.quantity} ${stronger.unit}) strictly subsumes ${weaker.id} (${weaker.comparator} ${weaker.quantity} ${weaker.unit})`
      };
    }
  }

  return null;
}

/** Detect physically or architecturally infeasible latency bounds. */
function detectInfeasibleLatency(asts, profile = {}) {
  const findings = [];
  const globalAiEveryCall = asts.filter((a) => a.flags.callsAi && a.flags.appliesToEveryRequest);
  const globalExtEveryCall = asts.filter((a) => a.flags.mustCallExternal && a.flags.appliesToEveryRequest);
  const globalPayEveryCall = asts.filter((a) => a.flags.callsPaymentRail && a.flags.appliesToEveryRequest);
  const globalCrossRegion = asts.filter((a) => a.flags.crossRegionSync && a.flags.appliesToEveryRequest);

  for (const ast of asts) {
    if (ast.negated) continue;
    if (ast.unitFamily !== 'time' || ast.normalizedValue === null) continue;
    if (ast.comparator !== 'lte' && ast.comparator !== 'lt' && ast.comparator !== 'eq') continue;
    if (ast.predicate !== 'respond' && !/\b(?:within|under|less\s+than|<|<=|p99|p95|latency|ms|milliseconds?)\b/i.test(ast.text)) {
      continue;
    }

    const budgetMs = ast.normalizedValue;
    const checks = [];

    if (ast.flags.callsPaymentRail || (ast.flags.appliesToEveryRequest && globalPayEveryCall.length > 0)) {
      const peer = globalPayEveryCall.find((p) => p.id !== ast.id);
      checks.push({ ...LATENCY_FLOORS_MS.paymentRails, category: 'paymentRails', peerId: peer?.id ?? null });
    }
    if (ast.flags.callsAi || (ast.flags.appliesToEveryRequest && globalAiEveryCall.length > 0)) {
      const peer = globalAiEveryCall.find((p) => p.id !== ast.id);
      checks.push({ ...LATENCY_FLOORS_MS.ai, category: 'ai', peerId: peer?.id ?? null });
    }
    if (ast.flags.crossRegionSync || (ast.flags.appliesToEveryRequest && globalCrossRegion.length > 0)) {
      const peer = globalCrossRegion.find((p) => p.id !== ast.id);
      checks.push({ ...LATENCY_FLOORS_MS.crossRegion, category: 'crossRegion', peerId: peer?.id ?? null });
    }
    if (
      checks.length === 0 &&
      (ast.flags.mustCallExternal || (ast.flags.appliesToEveryRequest && globalExtEveryCall.length > 0))
    ) {
      const peer = globalExtEveryCall.find((p) => p.id !== ast.id);
      checks.push({ ...LATENCY_FLOORS_MS.externalApi, category: 'externalApi', peerId: peer?.id ?? null });
    }
    // Also catch explicit AI trait + sub-200ms AI endpoint rule.
    if (
      checks.length === 0 &&
      Array.isArray(profile?.traits) &&
      profile.traits.includes('ai') &&
      /\b(?:inference|completion|prompt|chat\s+reply|ai|model|generation)\b/i.test(ast.text)
    ) {
      checks.push({ ...LATENCY_FLOORS_MS.ai, category: 'ai', peerId: null });
    }

    for (const check of checks) {
      if (budgetMs < check.floorMs) {
        const rules = check.peerId ? [ast.id, check.peerId] : [ast.id];
        const label = check.peerId ? `${ast.id} ⟂ ${check.peerId}` : `${ast.id} (infeasible latency)`;
        findings.push({
          kind: 'infeasible-latency',
          severity: 'error',
          category: check.category,
          rules,
          label,
          budgetMs,
          floorMs: check.floorMs,
          reason: `${label}: target ${ast.quantity}${ast.unit} (${budgetMs}ms) is below the ${check.label}${check.peerId ? ` required by ${check.peerId}` : ''}`
        });
      }
    }
  }
  return findings;
}

function matchConflictResolution(ruleA, ruleB, resolutions = []) {
  const identifiersA = new Set([ruleA.id, ruleA.key, ruleA.key?.replace(/^custom\./, '')].filter(Boolean));
  const identifiersB = new Set([ruleB.id, ruleB.key, ruleB.key?.replace(/^custom\./, '')].filter(Boolean));
  for (const res of resolutions) {
    if (!res || !Array.isArray(res.rules) || res.rules.length !== 2) continue;
    const [x, y] = res.rules;
    if ((identifiersA.has(x) && identifiersB.has(y)) || (identifiersA.has(y) && identifiersB.has(x))) {
      return res;
    }
  }
  return null;
}

/**
 * Run full cross-rule contradiction, infeasibility, and duplicate/subsumption
 * analysis across compiled requirements and `profile.conflicts`.
 */
export function lintRules(requirements = [], profile = {}) {
  const customReqs = requirements.filter((r) => r.origin === 'profile' || String(r.id ?? '').startsWith('REQ-C'));
  const catalogReqs = requirements.filter((r) => r.origin !== 'profile' && !String(r.id ?? '').startsWith('REQ-C'));
  const customAsts = customReqs.map(parseRuleAst);
  const catalogAsts = catalogReqs.map(parseRuleAst);
  const resolutions = Array.isArray(profile?.conflicts) ? profile.conflicts : [];

  const contradictions = [];
  const resolvedConflicts = [];
  const duplicates = [];

  // 1. Pairwise custom-vs-custom checks.
  for (let i = 0; i < customAsts.length; i += 1) {
    for (let j = i + 1; j < customAsts.length; j += 1) {
      const a = customAsts[i];
      const b = customAsts[j];
      const clash = detectPairContradiction(a, b);
      if (clash) {
        const label = `${a.id} ⟂ ${b.id}`;
        const resolution = matchConflictResolution(a, b, resolutions);
        const record = {
          kind: 'contradiction',
          severity: resolution ? 'resolved' : 'error',
          rules: [a.id, b.id],
          keys: [a.key, b.key],
          label,
          reason: `${label}: ${clash}`
        };
        if (resolution) {
          resolvedConflicts.push({ ...record, winner: resolution.winner, resolutionReason: resolution.reason });
        } else {
          contradictions.push(record);
        }
        continue;
      }

      const dup = detectDuplicateOrSubsumption(a, b);
      if (dup) {
        duplicates.push({ ...dup, severity: 'warning' });
      }
    }
  }

  // 2. Custom-vs-catalog regulatory contradiction checks (e.g. custom rule says
  // "Allow anonymous access to all endpoints" or "Store passwords in plaintext"
  // or "Delete all financial records immediately" against a SOX/HIPAA 6-7y overlay).
  for (const custom of customAsts) {
    for (const cat of catalogAsts) {
      // Only check high-confidence semantic flag clashes against catalog rules so
      // normal custom refinements never produce false positives.
      if (custom.hasCarveout || cat.hasCarveout) continue;
      let clash = null;
      if (custom.flags.immediateDelete && cat.flags.mandatoryRetention && /\b(?:6|7|five|six|seven)\s+years?\b/i.test(cat.text)) {
        clash = `custom rule requests immediate deletion ("${custom.text}") while ${cat.id} mandates multi-year retention ("${cat.title ?? cat.text}")`;
      } else if (custom.flags.requiresPlaintext && cat.flags.requiresEncryption && subjectsCompatible(custom, cat)) {
        clash = `custom rule mandates plaintext ("${custom.text}") while ${cat.id} mandates encryption`;
      }
      if (!clash) continue;
      const label = `${custom.id} ⟂ ${cat.id}`;
      const resolution = matchConflictResolution(custom, cat, resolutions);
      const record = {
        kind: 'contradiction',
        severity: resolution ? 'resolved' : 'error',
        rules: [custom.id, cat.id],
        keys: [custom.key, cat.key],
        label,
        reason: `${label}: ${clash}`
      };
      if (resolution) {
        resolvedConflicts.push({ ...record, winner: resolution.winner, resolutionReason: resolution.reason });
      } else {
        contradictions.push(record);
      }
    }
  }

  // 3. Infeasible physical/architectural latency floors.
  const rawInfeasible = detectInfeasibleLatency(customAsts, profile);
  const infeasible = [];
  for (const item of rawInfeasible) {
    if (item.rules.length === 2) {
      const a = customAsts.find((x) => x.id === item.rules[0]);
      const b = customAsts.find((x) => x.id === item.rules[1]);
      const res = a && b ? matchConflictResolution(a, b, resolutions) : null;
      if (res) {
        resolvedConflicts.push({ ...item, severity: 'resolved', winner: res.winner, resolutionReason: res.reason });
        continue;
      }
    }
    infeasible.push(item);
  }

  const blocking = [...contradictions, ...infeasible];
  return {
    schemaVersion: 1,
    ok: blocking.length === 0,
    rulesChecked: customAsts.length,
    parsedRules: customAsts.map((ast) => ({
      id: ast.id,
      key: ast.key,
      subject: ast.subject,
      modal: ast.modal,
      predicate: ast.predicate,
      object: ast.object,
      quantity: ast.quantity,
      unit: ast.unit,
      comparator: ast.comparator,
      negated: ast.negated
    })),
    contradictions,
    infeasible,
    resolvedConflicts,
    duplicates,
    blockingCount: blocking.length,
    warningCount: duplicates.length
  };
}

/** Convenience helper to lint a raw array of rule strings/objects directly. */
export function lintRawRuleList(rules = [], { profile = {}, conflicts = [] } = {}) {
  const synth = rules.map((entry, idx) => {
    const id = `REQ-C${String(idx + 1).padStart(2, '0')}`;
    const text = typeof entry === 'string' ? entry : String(entry?.text ?? entry?.statement ?? '');
    const key = typeof entry === 'object' && entry?.slug ? `custom.${entry.slug}` : `custom.rule-${idx + 1}`;
    return {
      id,
      key,
      origin: 'profile',
      title: text,
      sourceRuleText: text,
      statement: text
    };
  });
  return lintRules(synth, { ...profile, conflicts: conflicts.length > 0 ? conflicts : (profile.conflicts ?? []) });
}

/** Format human-readable rule-lint findings for CLI output and plan warnings. */
export function formatRuleLintFindings(report) {
  if (!report) return { errors: [], warnings: [], resolved: [] };
  const errors = [
    ...(report.contradictions ?? []).map(
      (c) => `rule conflict (${c.label}): ${c.reason}. Resolve in profile.conflicts: [{ "rules": ${JSON.stringify(c.rules)}, "winner": "${c.rules[1]}", "reason": "..." }].`
    ),
    ...(report.infeasible ?? []).map(
      (f) => `rule infeasible (${f.reason}). Relax the latency threshold, move the external call async, or record a resolution in profile.conflicts.`
    )
  ];
  const warnings = (report.duplicates ?? []).map(
    (d) => `rule ${d.kind} (${d.label}): ${d.reason}`
  );
  const resolved = (report.resolvedConflicts ?? []).map(
    (r) => `${r.label} -> winner ${r.winner} (${r.resolutionReason})`
  );
  return { errors, warnings, resolved };
}
