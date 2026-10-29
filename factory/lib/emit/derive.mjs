/**
 * Derivation: everything the packet needs that is not already in the plan.
 *
 * Kept separate from rendering so that "what does the spec claim" and "how is it
 * formatted" can be reviewed independently.
 */

import { aggregatesFor, contextsFor, termsFor } from '../domain-hints.mjs';

export const FACTORY_VERSION = '0.3.0';

// ---------- text helpers ----------

export const heading = (level, text) => `${'#'.repeat(level)} ${text}`;

export const bullets = (items) => items.filter(Boolean).map((item) => `- ${item}`).join('\n');

export const ordered = (items) => items.filter(Boolean).map((item, index) => `${index + 1}. ${item}`).join('\n');

export const checkboxes = (items) => items.filter(Boolean).map((item) => `- [ ] ${item}`).join('\n');

export function table(headers, rows) {
  if (rows.length === 0) return '_None._';
  const head = `| ${headers.join(' | ')} |`;
  const divider = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map((cell) => String(cell ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`);
  return [head, divider, ...body].join('\n');
}

export const titleize = (slug) =>
  String(slug)
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

export const slugOf = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const code = (lang, body) => `\`\`\`${lang}\n${body.trim()}\n\`\`\``;

export const quote = (text) => String(text).split('\n').map((line) => `> ${line}`).join('\n');

// ---------- stack ----------

const TS_STACK = {
  language: 'TypeScript (strict)',
  runtime: 'Node.js 22 LTS',
  ui: 'React + Vite (only if a UI is in scope)',
  http: 'Hono or Fastify, typed handlers',
  db: 'PostgreSQL + Drizzle (forward-only SQL migrations)',
  validation: 'Zod at every boundary (input, env, external API)',
  unitRunner: 'Vitest',
  tests: 'Vitest for unit and integration, Playwright for the primary journey',
  lint: 'ESLint + Prettier, typecheck in CI',
  logs: 'pino with a correlation ID field',
  ci: 'GitHub Actions'
};

const PY_STACK = {
  language: 'Python 3.12',
  runtime: 'CPython',
  ui: 'HTMX or a thin React island only if a UI is in scope',
  http: 'FastAPI with Pydantic models at the boundary',
  db: 'PostgreSQL + SQLAlchemy Core/Alembic (forward-only migrations)',
  validation: 'Pydantic at every boundary (input, env, external API)',
  unitRunner: 'pytest',
  tests: 'pytest for unit and integration, Playwright for the primary journey',
  lint: 'ruff + mypy, both blocking in CI',
  logs: 'structlog with a correlation ID field',
  ci: 'GitHub Actions'
};

const GO_STACK = {
  language: 'Go 1.23',
  runtime: 'the Go toolchain, shipped as a single static binary',
  ui: 'templ + HTMX only if a UI is in scope',
  http: 'net/http with chi, typed handlers and explicit error returns',
  db: 'PostgreSQL + pgx, forward-only migrations with goose',
  validation: 'explicit decode and validation at the boundary (no reflection magic)',
  unitRunner: 'go test',
  tests: 'go test for unit and integration, chromedp only if a UI exists',
  lint: 'golangci-lint + go vet, both blocking in CI',
  logs: 'slog with a correlation ID field',
  ci: 'GitHub Actions'
};

const PYTHONISH = /python|fastapi|django|flask|pytest|poetry|uv/;
const GOISH = /(^|[^a-z])go([^a-z]|$)|golang|go 1\./;

export function isPythonStack(profile) {
  return PYTHONISH.test(String(profile.constraints?.stack ?? '').toLowerCase());
}

export function isGoStack(profile) {
  return GOISH.test(String(profile.constraints?.stack ?? '').toLowerCase());
}

const TSISH = /typescript|node|react|vite|javascript|undecided|^$/;

export function recognisesStack(profile) {
  const declared = String(profile.constraints?.stack ?? 'undecided').toLowerCase();
  return isGoStack(profile) || isPythonStack(profile) || TSISH.test(declared);
}

/**
 * The commands an agent must be able to run, derived from the declared stack.
 * A stack this tool has no profile for gets `null`, not a TypeScript default: an
 * invented command is worse than an honest gap, because the agent will run it.
 */
export function commandsFor(profile) {
  if (isGoStack(profile)) return ['go build ./...', 'go vet ./...', 'go test ./...'];
  if (isPythonStack(profile)) return ['ruff check .', 'mypy .', 'pytest'];
  if (TSISH.test(String(profile.constraints?.stack ?? 'undecided').toLowerCase())) return ['npm run lint', 'npm run typecheck', 'npm test'];
  return null;
}

const UNKNOWN_COMMANDS = 'record the real build and test commands here and in the README before implementation starts';

/**
 * Text from a profile is user input, and user input must not become document
 * structure. Flatten it before it is embedded in a line of prose.
 */
export function inline(text, limit = 600) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').replace(/^[#>\s]+/, '').trim();
  return flat.length > limit ? `${flat.slice(0, limit).trimEnd()}… (full text in profile.json)` : flat;
}

export function stackFor(profile) {
  const declared = String(profile.constraints.stack || 'undecided').toLowerCase();
  const pythonish = PYTHONISH.test(declared);
  const goish = !pythonish && GOISH.test(declared);
  const recognised = declared === 'undecided' || pythonish || goish || /typescript|node|react|vite|javascript/.test(declared);
  const base = pythonish ? PY_STACK : goish ? GO_STACK : TS_STACK;
  const mustUse = profile.constraints.mustUse ?? [];

  // unitRunner is an implementation detail of the `tests` row, not a layer.
  const rows = Object.entries(base)
    .filter(([layer]) => layer !== 'unitRunner')
    .map(([layer, choice]) => [
    layer,
    choice,
    layer === 'db'
      ? 'Boring and relational beats novel and eventual for a first version.'
      : layer === 'tests'
        ? 'Fast feedback for logic, one slow test for the journey.'
        : 'Fewer moving parts means fewer invented abstractions.'
  ]);

  return {
    stack: base,
    rows,
    mustUse,
    recognised,
    note: !recognised
      ? `The declared stack (${declared}) is not one this packet has a built-in profile for, so the table above is a TypeScript default and must be replaced. Record an ADR that names the real language, test runner and migration tool before implementation starts; the requirements and gates are language-neutral and do not change.`
      : mustUse.length > 0
        ? `Declared constraints: ${mustUse.join(', ')}. Keep them; record an ADR explaining how they fit, and do not add a second framework that duplicates their job.`
        : 'This is the default. Override it only through an ADR that names the trade-off; the tests and gates do not depend on any specific framework.'
  };
}

// ---------- requirements ----------

const RENDER_LABEL = {
  core: 'Foundation',
  data: 'Data',
  security: 'Security',
  frontend: 'Interface',
  api: 'Interface & contracts',
  reliability: 'Reliability',
  ai: 'Model-backed features'
};

export function groupRequirements(requirements) {
  const groups = new Map();
  for (const requirement of requirements) {
    const key = requirement.render ?? 'core';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(requirement);
  }
  return [...groups.entries()].map(([render, items]) => ({
    render,
    label: RENDER_LABEL[render] ?? titleize(render),
    items
  }));
}

export function anchorPath(profile, requirement) {
  const name = slugOf(requirement.key);
  const ext = isPythonStack(profile) ? 'py' : isGoStack(profile) ? 'go' : 'ts';
  return `tests/${requirement.render}/${name}.test.${ext}`;
}

// ---------- non-goals and questions ----------

export function nonGoalsFor(profile) {
  const goals = [
    'Anything not listed under "In scope" in the product brief. When in doubt, it is out of scope.',
    'A general-purpose platform, plugin system or public extension API. v1 ships one product.',
    'Multi-region deployment and horizontal scale-out beyond the stated user scale.',
    'A native mobile client or desktop wrapper unless "mobile" is the declared kind.',
    'Single sign-on, SCIM provisioning and enterprise procurement features.',
    'A migration path from an existing system. v1 starts clean and imports nothing.'
  ];

  if (!profile.traits.includes('realtime')) goals.push('Realtime collaboration, presence and live cursors.');
  if (!profile.traits.includes('ai')) goals.push('Model-backed features, chat interfaces and semantic search.');
  if (!profile.traits.includes('notifications')) goals.push('Email, push and digest notification delivery.');
  if (profile.kind === 'web-app' || profile.kind === 'api') goals.push('A public API for third parties, SDKs and published integrations.');

  return goals;
}

export function openQuestionsFor(profile, rigor) {
  const questions = [
    'Who is the single primary user of v1, and what do they do today instead of using this?',
    'What is the one action that must never fail, and what does failure cost the user?',
    'Which in-scope capability could be removed without destroying the core value?',
    'What is the expected order of magnitude of data — rows, events per day, concurrent users?',
    'Who notices first when this breaks, and through which channel?'
  ];

  if (profile.risks.pii) questions.push('Which fields are personal data, and what is the retention period and lawful basis for each?');
  if (profile.risks.payments) questions.push('Which payment provider, which currencies, who issues refunds, and what is the refund window?');
  if (profile.risks.multiTenant) questions.push('How is a tenant created, and can one person belong to more than one tenant?');
  if (profile.traits.includes('ai')) questions.push('What failure rate is acceptable for model output, and what does the user see when it is wrong?');
  if (profile.traits.includes('auth')) questions.push('Which sign-in methods are in scope for v1 — password, magic link, OAuth provider?');
  if (profile.kind === 'data-pipeline') questions.push('What is the freshness requirement, and what is the cost of a wrong or duplicate row?');
  if (rigor.tier >= 2) questions.push('What is the availability target, and what error budget are you willing to spend per month?');

  return questions;
}

// ---------- delivery ----------

export function buildPhases(plan) {
  const { profile, requirements, primitives } = plan;
  const groups = groupRequirements(requirements);
  const weeks = profile.constraints.weeks;
  const hasMutation = primitives.some((primitive) => primitive.id === 'testing.mutation-testing');
  const hasThreat = primitives.some((primitive) => primitive.id === 'security.threat-model');
  const hasObservability = primitives.some((primitive) => primitive.id === 'reliability.observability-baseline');
  const hasTokens = primitives.some((primitive) => primitive.id === 'frontend.design-system-tokens');

  const reqList = (render) => (groups.find((group) => group.render === render)?.items ?? []);

  const phases = [
    {
      name: 'Phase 0 — Skeleton and guardrails',
      goal: 'A running, tested, documented empty box. Nothing built on a broken foundation.',
      tasks: [
        'Initialise the repository with the chosen stack; commit the lockfile.',
        'Add the CI workflow with lint, typecheck and test jobs. Make it required on the default branch.',
        'Add environment validation that names every missing variable at startup.',
        'Write the README runbook: install, run, test, deploy, known limitations.',
        'Copy the specification packet into specs/ and wire the spec check into CI.',
        `Resolve open questions that block in-scope work (see product brief). Unresolved questions block only their area.`
      ],
      exit: 'A new contributor can clone, run and test with the documented commands. CI is green on an empty suite.'
    },
    {
      name: 'Phase 1 — Domain core',
      goal: 'The rules of the product, expressed in code, before any framework is chosen for them.',
      tasks: [
        'Fill the ubiquitous language table: one term, one meaning, no synonyms.',
        'Write failing tests for each invariant in the domain model.',
        'Implement the aggregates as pure code with no framework, network or database imports.',
        'Define typed domain errors; no exception control flow across module boundaries.',
        hasMutation ? 'Run the mutation check on the domain layer and record the baseline score.' : 'Review assertion quality manually; every test must fail if the rule is inverted.'
      ],
      exit: 'Domain tests pass and the domain layer imports nothing from infrastructure.'
    },
    {
      name: 'Phase 2 — Contracts before implementation',
      goal: 'Every boundary is fixed while changing it is still free.',
      tasks: [
        `Finalise each interface shape in the contract inventory: ${reqList('api').map((r) => r.id).join(', ') || 'internal module interfaces'}.`,
        'Write acceptance tests that encode the criteria in the verification plan. They must fail.',
        'Write contract tests for external dependencies, or record the stub and the reason.',
        'Record an ADR for each chosen library that could plausibly be replaced.'
      ],
      exit: 'Acceptance tests exist and fail for the right reason (missing behaviour, not missing setup).'
    },
    {
      name: 'Phase 3 — Vertical slices',
      goal: 'Working software end to end, one requirement at a time.',
      tasks: groups
        .filter((group) => group.render !== 'core' && group.render !== 'frontend')
        .flatMap((group) =>
          group.items.map((requirement) => `${requirement.id} ${requirement.title} — test, implement, trace, repeat.`)
        ),
      exit: 'Each requirement is traceable from criterion to test, and its anchor is green in CI.'
    },
    {
      name: 'Phase 4 — Interface and hardening',
      goal: 'The product feels finished and fails predictably.',
      tasks: [
        ...reqList('frontend').map((requirement) => `${requirement.id} ${requirement.title}.`),
        hasTokens ? 'Bind every component to design tokens; remove raw values.' : null,
        hasThreat ? 'Walk the threat model; each accepted mitigation becomes a control or a test.' : null,
        hasObservability ? 'Add correlation IDs and one alert on error rate.' : null,
        'Exercise every failure path in the requirements, manually or by test.',
        hasMutation ? 'Raise the mutation score to target on the domain layer.' : 'Mutation testing is deferred; keep assertions specific anyway.'
      ],
      exit: 'All gates for the tier pass in CI, and manual verification scripts have been run once.'
    },
    {
      name: 'Phase 5 — Release and first observation',
      goal: 'Ship with a way back.',
      tasks: [
        'Write the release checklist and the rollback procedure.',
        'Deploy to a staging environment and run the primary journey there.',
        'Observe for one window: error rate, latency, and one real user journey.',
        'Record what changed in the spec as a result, then archive the changed requirements.'
      ],
      exit: 'A release has been observed and a rollback has been rehearsed or explicitly accepted as untested.'
    }
  ];

  const weights = [0.15, 0.2, 0.15, 0.3, 0.15, 0.05];
  let cursor = 1;
  return phases.map((phase, index) => {
    const span = Math.max(1, Math.round(weeks * weights[index]));
    const start = cursor;
    const end = Math.min(weeks, start + span - 1);
    cursor = end + 1;
    return { ...phase, weeks: `${start}-${end}`, order: index };
  });
}

export function copyBrief(plan) {
  const { profile, requirements, rigor } = plan;
  const scope = requirements
    .filter((requirement) => requirement.verify === 'automated' || requirement.render !== 'core')
    .slice(0, 12)
    .map((requirement) => requirement.title);

  // A single-file packet does not ship the documents a full packet does, so an
  // instruction to read them is an instruction to read a missing file.
  const single = plan.packet === 'single-file';
  const readFirst = single
    ? '1. Read specs/AGENTS.md first, then spec.md (this file). The whole specification is those two.'
    : '1. Read specs/AGENTS.md first, then specs/07-agent-handoff.md. Follow the loop there.';
  const adrRule = single
    ? '4. Do not add a dependency without writing down what it replaces and what breaks without it.'
    : '4. Do not add a dependency without an ADR entry in specs/03-architecture.md.';
  const outOfScope = single
    ? 'Out of scope: anything not listed above or in the non-goals above.'
    : 'Out of scope: anything not listed above, plus the non-goals in specs/01-product-brief.md.';
  const gates = single
    ? `Rigor tier: ${rigor.tier} (${rigor.label}) — the gates in section 5 are the definition of done.`
    : `Rigor tier: ${rigor.tier} (${rigor.label}) — gates in specs/05-verification.md are the definition of done.`;

  return [
    `Build "${titleize(profile.name)}": ${inline(profile.idea, 400)}`,
    '',
    `Non-negotiable rules for this build:`,
    readFirst,
    `2. Implement only what specs/spec.json lists as requirements. No extra endpoints, screens or abstractions.`,
    `3. Write a failing test before the behaviour, and add an @req anchor to every automated requirement.`,
    adrRule,
    `5. Do not delete or weaken a test to make something pass. Stop and report instead.`,
    `6. Keep files under ~300 lines and keep the domain layer free of framework imports.`,
    '',
    `V1 scope: ${scope.join('; ')}.`,
    outOfScope,
    `Stack: ${plan.config.stack === 'undecided' ? 'not fixed yet — pick one and record it before Phase 1' : plan.config.stack} — ${commandsFor(profile)?.join(' && ') ?? UNKNOWN_COMMANDS}.`,
    gates,
    '',
    'Start with Phase 0, then Phase 1. Stop after each phase and report: what changed, which tests pass, which requirement moved, what you are unsure about.'
  ].join('\n');
}

// ---------- obligations the catalog cannot see ----------

const NORMATIVE = /\b(must|must not|cannot|can never|never|always|only|at most|at least|no more than|has to|have to|is required to|are required to)\b/i;
const OBLIGATION_STOP = new Set([
  'must', 'never', 'always', 'only', 'that', 'this', 'with', 'from', 'into', 'they', 'their', 'them',
  'then', 'than', 'when', 'what', 'which', 'while', 'have', 'has', 'been', 'being', 'each', 'every',
  'some', 'such', 'more', 'most', 'other', 'same', 'also', 'over', 'under', 'after', 'before', 'about',
  'because', 'between', 'there', 'where', 'these', 'those', 'records', 'record', 'state', 'system',
  'service', 'application', 'product', 'users', 'user', 'data', 'means', 'write', 'writes', 'written',
  'given', 'criterion', 'criteria', 'acceptance', 'test', 'tests', 'requirement', 'requirements'
]);

const words = (text) =>
  String(text)
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((word) => word.length >= 4 && !OBLIGATION_STOP.has(word));

/**
 * Sentences in the idea that state an obligation the catalog does not already
 * turn into a requirement.
 *
 * The catalog knows classes of obligation ("payments must be correct under
 * retries"); it cannot know that *this* payout must not run twice for the same
 * seller and day. Dropping such a sentence silently is how a spec that looks
 * complete produces software that is not. So the packet lists them: either turn
 * one into a requirement with `vld change`, or write it down as a non-goal.
 */
export function unmappedObligations(profile, requirements, domainText = '') {
  const known = words(
    requirements
      .map((requirement) => `${requirement.title} ${requirement.statement} ${(requirement.acceptance ?? []).map((ac) => ac.text).join(' ')}`)
      .concat(domainText)
      .join(' ')
  );
  // No stemming library, so compare on prefixes: "authorized" and "authorization"
  // are the same obligation, and so are "read" and "reading".
  const shares = (word) => known.some((other) => other === word || other.startsWith(word) || word.startsWith(other));

  const sentences = String(profile.idea ?? '')
    .split(/(?<=[.!?;])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 25 && NORMATIVE.test(sentence));

  return sentences
    .map((sentence) => {
      const own = [...new Set(words(sentence))];
      const shared = own.filter((word) => shares(word));
      return { sentence, shared: shared.length, own: own.length };
    })
    .filter((entry) => entry.shared < Math.max(2, Math.ceil(entry.own * 0.5)))
    .map((entry) => entry.sentence);
}

// ---------- whole-packet derivation ----------

export function derive(plan) {
  const contexts = contextsFor(plan.profile);
  const aggregates = aggregatesFor(plan.requirements);
  // Invariants the domain model already states count as coverage: the idea's
  // rule is in the packet even when no requirement carries it.
  const domainText = aggregates
    .map((aggregate) => `${aggregate.name} ${(aggregate.invariants ?? []).join(' ')}`)
    .join(' ');
  return {
    project: titleize(plan.profile.name),
    contexts,
    terms: termsFor(plan.requirements),
    aggregates,
    groups: groupRequirements(plan.requirements),
    nonGoals: nonGoalsFor(plan.profile),
    questions: openQuestionsFor(plan.profile, plan.rigor),
    stack: stackFor(plan.profile),
    commands: commandsFor(plan.profile),
    phases: buildPhases(plan),
    brief: copyBrief(plan),
    unmapped: unmappedObligations(plan.profile, plan.requirements, domainText),
    anchors: new Map(plan.requirements.map((requirement) => [requirement.id, anchorPath(plan.profile, requirement)]))
  };
}
