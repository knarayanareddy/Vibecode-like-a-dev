/**
 * Derivation: everything the packet needs that is not already in the plan.
 *
 * Kept separate from rendering so that "what does the spec claim" and "how is it
 * formatted" can be reviewed independently.
 */

import { aggregatesFor, contextsFor, termsFor } from '../domain-hints.mjs';
import { articleFor, ideaNouns, singularOf, vocabularyFor } from './vocabulary.mjs';

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

export function nonGoalsFor(profile, words = []) {
  const primary = words[0] ?? 'the primary object';
  const secondary = words[1] ?? 'the people who use it';
  const aPrimary = `${articleFor(primary)} ${primary}`;
  const goals = [
    `Any ${primary} capability the idea does not name. When in doubt, it is out of scope and gets its own version.`,
    `Importing ${primary} data from an existing system: v1 starts empty and the first ${secondary} enters it by hand.`
  ];

  if (!profile.traits.includes('realtime')) goals.push('Live collaboration on the same ' + primary + ', presence and cursors.');
  if (!profile.traits.includes('ai')) goals.push(`Any generated or summarised ${primary} content. Every word in v1 is written by ${articleFor(secondary.replace(/s$/, ''))} ${secondary.replace(/s$/, '')}.`);
  if (!profile.traits.includes('notifications')) goals.push(`Notifying ${secondary} outside the product: no email, no push, no digest.`);
  if (profile.kind === 'web-app' || profile.kind === 'api') goals.push(`A public ${primary} API for third parties, SDKs and published integrations.`);
  if (profile.kind !== 'mobile') goals.push(`A native client for the ${primary}. If ${secondary} need it offline, that is a v2 decision with its own sync contract.`);
  goals.push(`Custom reporting and exports over ${primary} data beyond what one screen shows.`);
  return goals;
}

export function openQuestionsFor(profile, rigor, words = []) {
  const primary = words[0] ?? 'the primary object';
  const secondary = words[1] ?? 'users';
  const aPrimary = `${articleFor(primary)} ${primary}`;
  const questions = [
    `Who creates the first ${primary}, and what do they use today instead?`,
    `What must never happen to ${aPrimary} — and what does it cost when it does?`,
    `Which part of the ${primary} workflow could be dropped without losing the reason ${secondary} open it?`,
    `How many ${primary} records exist in year one, and how many ${secondary} touch them at once?`,
    `Who notices first when ${aPrimary} is wrong, and how do they find out?`
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

export function buildPhases(plan, phrases) {
  const { profile, requirements, primitives } = plan;
  const groups = groupRequirements(requirements);
  const weeks = profile.constraints.weeks;
  const hasMutation = primitives.some((primitive) => primitive.id === 'testing.mutation-testing');
  const hasThreat = primitives.some((primitive) => primitive.id === 'security.threat-model');
  const hasObservability = primitives.some((primitive) => primitive.id === 'reliability.observability-baseline');
  const hasTokens = primitives.some((primitive) => primitive.id === 'frontend.design-system-tokens');

  const reqList = (render) => (groups.find((group) => group.render === render)?.items ?? []);
  const vocab = vocabularyFor(profile);
  const { primary, aPrimary, secondary, secondaryPlural } = vocab;
  const aSecondary = `${articleFor(secondary)} ${secondary}`;
  const db = String(stackFor(profile).stack.db).split(/[(+]/)[0].trim();
  const projectLabel = titleize(profile.name).replace(/^\d+\s*/, '');
  const gatesCount = plan.gates?.length ?? 0;

  const phases = [
    {
      name: 'Phase 0 — Skeleton and guardrails',
      goal: `A running, tested, documented box that can create and delete ${aPrimary} and nothing else.`,
      tasks: [
        `Initialise the repository with ${stackFor(profile).stack.language} and ${db}; commit the lockfile.`,
        'Add the CI workflow with lint, typecheck and test jobs, and make it required on the default branch.',
        `Add configuration validation that names every missing variable before the first ${primary} is created.`,
        `Write the runbook: install, run, test, deploy, and what ${secondary}s see when the ${primary} service is down.`,
        'Copy the specification packet into specs/ and wire the spec check into CI.',
        `Answer the open questions that block the ${primary} slice; the rest can wait for their phase.`
      ],
      exit: `The documented command creates and deletes ${aPrimary} through ${db}, and CI is green on that alone.`
    },
    {
      name: 'Phase 1 — Domain core',
      goal: `The rules that make ${aPrimary} valid, in code, before any framework is chosen for them.`,
      tasks: [
        `Fill the language table around ${aPrimary}: one term, one meaning, no synonyms.`,
        `Write failing tests for each rule ${aPrimary} must satisfy, including the ones the idea states in its own words.`,
        `Implement the ${primary} aggregates as pure code with no framework, network or database imports.`,
        `Define typed errors for the ways ${aPrimary} can be rejected; no exception control flow across module boundaries.`,
        hasMutation ? `Run the mutation check on the ${primary} domain and record the baseline score.` : `Review assertion quality by hand: every ${primary} test must fail if its rule is inverted.`
      ],
      exit: `${aPrimary.charAt(0).toUpperCase()}${aPrimary.slice(1)} rules pass their tests with no infrastructure imported — no ${db}, no framework.`
    },
    {
      name: 'Phase 2 — Contracts before implementation',
      goal: `Every boundary around ${aPrimary} fixed while changing it is still free.`,
      tasks: [
        `Fix each shape in the contract inventory: ${reqList('api').map((r) => r.id).join(', ') || 'internal module interfaces behind the ' + primary + ' use case'}.`,
        `Write the acceptance tests for ${aPrimary} first; they must fail for missing behaviour, not missing setup.`,
        'Record a real response for every external dependency, or write down the stub and why.',
        `Record an ADR for each library that a reviewer could plausibly want removed.`
      ],
      exit: `The ${aPrimary} acceptance tests exist and fail because the behaviour is missing, not because the setup is.`
    },
    {
      name: 'Phase 3 — Vertical slices',
      goal: `Working ${primary} behaviour end to end, one requirement at a time.`,
      tasks: groups
        .filter((group) => group.render !== 'core' && group.render !== 'frontend')
        .flatMap((group) =>
          group.items.map(
            (requirement) => `${requirement.id} ${phrases?.get(requirement.key) ?? requirement.title} Test first, then implement, then trace.`
          )
        ),
      exit: `Each of the ${requirements.length} requirements is traceable from criterion to test, with its anchor green in CI.`
    },
    {
      name: 'Phase 4 — Interface and hardening',
      goal: `${projectLabel} feels finished to ${aSecondary} and fails predictably.`,
      tasks: [
        ...reqList('frontend').map((requirement) => `${requirement.id} ${phrases?.get(requirement.key) ?? requirement.title}`),
        hasTokens ? 'Bind every component to design tokens; remove raw values.' : null,
        hasThreat ? 'Walk the threat model; each accepted mitigation becomes a control or a test.' : null,
        hasObservability ? 'Add correlation IDs and one alert on error rate.' : null,
        'Exercise every failure path in the requirements, manually or by test.',
        hasMutation ? 'Raise the mutation score to target on the domain layer.' : 'Mutation testing is deferred; keep assertions specific anyway.'
      ],
      exit: `All ${gatesCount} gates pass in CI, and the manual checks have been run once and dated.`
    },
    {
      name: 'Phase 5 — Release and first observation',
      goal: `Ship ${aPrimary} change with a way back.`,
      tasks: [
        `Write the release checklist and the rollback procedure for a ${db} migration.`,
        `Deploy to staging and take one ${primary} through the primary journey there.`,
        `Observe for one window: error rate, latency, and one ${primary} created by a real ${secondary}.`,
        'Record what changed in the spec as a result, then archive the changed requirements.'
      ],
      exit: `A release has been observed with real ${secondaryPlural} data, and the rollback has been rehearsed or explicitly accepted as untested.`
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


// ---------- product-specific derivation ----------
//
// A packet that reads the same for every product is a form letter. These helpers
// derive content from *this* profile: its nouns, its surfaces, its decisions and
// the requirement an agent should start with.

/** The architecture style this kind of product implies. */
export function styleFor(profile) {
  const styles = {
    'data-pipeline': {
      name: 'Staged pipeline with explicit contracts',
      why: 'Each stage has one job, a declared input and output, and a watermark that makes replay possible. A monolith here would hide the data dependencies that cause most pipeline incidents.'
    },
    cli: {
      name: 'Hexagonal single artifact',
      why: 'A CLI is a thin adapter over a pure core. Keeping IO at the edges is what makes the commands testable without spawning processes.'
    },
    library: {
      name: 'Stable core with a narrow surface',
      why: 'The public surface is the product. Everything behind it must be replaceable without a major version.'
    },
    agent: {
      name: 'Hexagonal task runner',
      why: 'Model calls, tools and storage are adapters. The decision logic must be testable with recorded inputs and no network.'
    },
    automation: {
      name: 'Hexagonal single artifact with explicit steps',
      why: 'Automation fails on the second run, not the first. Steps need their own state and their own tests.'
    }
  };
  return (
    styles[profile.kind] ?? {
      name: 'Modular monolith with enforced boundaries',
      why: 'One deployable, several modules, boundaries checked mechanically. Microservices multiply failure modes before a product has found its shape; the seams here are the ones that survive the split if it ever comes.'
    }
  );
}

/** The document that covers a requirement's area. Used to point, not to repeat. */
export const AREA_DOCUMENT = {
  core: '01-product-brief.md',
  data: '04-contracts.md',
  security: '04-contracts.md',
  api: '04-contracts.md',
  frontend: '04-contracts.md',
  reliability: '03-architecture.md',
  ai: '03-architecture.md',
  delivery: '06-delivery-plan.md'
};

/**
 * Requirement titles are written for every product at once, so a packet that only
 * quotes them reads like the catalog it came from. This phrases each selected
 * requirement in *this* product's vocabulary: the same obligation, said about the
 * things the idea actually names. `spec.json` keeps the canonical title, so ids and
 * anchors stay stable while the documents talk like the product.
 */
export function phrasesFor(plan, words) {
  const vocab = vocabularyFor(plan.profile);
  const project = titleize(plan.profile.name).replace(/^\d+\s*/, '');
  const fill = (template) =>
    String(template)
      .replace(/\{project\}/g, project)
      .replace(/\{aPrimary\}/g, vocab.aPrimary)
      .replace(/\{primaryPlural\}/g, vocab.primaryPlural)
      .replace(/\{primary\}/g, vocab.primary)
      .replace(/\{aSecondary\}/g, `${articleFor(vocab.secondary)} ${vocab.secondary}`)
      .replace(/\{secondaryPlural\}/g, vocab.secondaryPlural)
      .replace(/\{secondary\}/g, vocab.secondary)
      .replace(/\{db\}/g, dbLabel(plan.profile));

  const capitalise = (text) => String(text).replace(/^./, (char) => char.toUpperCase());
  return new Map(
    plan.requirements.map((requirement) => {
      // The catalog's product-language definition is the source of truth. A
      // requirement without one still gets a sentence, but the library eval
      // reports it, so the gap is visible instead of silent.
      const definition = requirement.definition ? fill(requirement.definition) : fill(`${requirement.title} holds for {aPrimary}.`);
      return [requirement.key, capitalise(definition)];
    })
  );
}

/** Where an agent should start: the first unfinished requirement, preferred order. */
export function firstOpenRequirement(plan) {
  const open = plan.requirements.filter((requirement) => requirement.verify !== 'manual');
  const byPreference = ['core.runnable', 'core.primary-journey', 'core.domain-invariants'];
  for (const key of byPreference) {
    const match = open.find((requirement) => requirement.key === key);
    if (match) return match;
  }
  return open[0] ?? plan.requirements[0];
}

/**
 * The interfaces this product implies, from its kind and traits. A packet that
 * lists "an HTTP surface" for a library has not read the profile.
 */
/**
 * Rules the idea states in its own words: "must", "never", "only", "cannot".
 * These are the product's invariants, as opposed to the catalog's generic ones,
 * and they are the part an agent must not paraphrase away.
 */
export function ownRulesFor(profile) {
  const idea = String(profile.idea ?? '');
  const sentences = idea
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((sentence) => sentence.trim().replace(/^[-*\d.\s]+/, ''))
    .filter((sentence) => sentence.length > 20 && /\b(must|never|only|cannot|can ?not|always|at most|at least|no more than)\b/i.test(sentence));
  return [...new Set(sentences)].slice(0, 6);
}

export function surfacesFor(plan) {
  const { profile } = plan;
  const rows = [];
  const add = (surface, why, version = 'v1') => rows.push([surface, why, version]);

  if (['web-app', 'api', 'agent'].includes(profile.kind)) {
    add('HTTP API', `the ${profile.kind} surface described in the brief`);
  }
  if (profile.kind === 'cli') add('Command line', 'one command per user-facing operation, documented grammar');
  if (profile.kind === 'library') add('Public module surface', 'everything a consumer may import, versioned');
  if (profile.kind === 'data-pipeline') add('Stage inputs/outputs', 'declared schema per stage, with a watermark');
  if (profile.kind === 'mobile') add('On-device store + sync API', 'local writes and the replay contract');
  if (profile.kind === 'automation') add('Trigger + step runner', 'schedule or event, each step idempotent');

  if (profile.traits.includes('auth')) add('Session / token', 'authenticate, refresh, revoke');
  if (profile.traits.includes('upload')) add('Upload', 'validated, contained, metadata-stripped');
  if (profile.traits.includes('payments')) add('Payment intent + webhook', 'money movement and provider callbacks');
  if (profile.traits.includes('webhooks')) add('Inbound webhook', 'signature-verified, idempotent by event id');
  if (profile.traits.includes('search')) add('Query', 'ranked results with a stable pagination contract');
  if (profile.traits.includes('notifications')) add('Notification dispatch', 'per-channel, deduplicated, user preferences respected');
  if (profile.traits.includes('ai')) add('Model call', 'declared input contract, validated output, timeout and cost ceiling');
  if (profile.traits.includes('realtime')) add('Realtime channel', 'ordering and reconnect semantics stated explicitly');
  if (profile.traits.includes('background-jobs')) add('Job payload', 'idempotent handler, at-least-once delivery acknowledged');
  if (profile.risks.multiTenant) add('Tenant scope', 'resolved from the authenticated context, never from the payload');

  return rows;
}

/**
 * Decisions this product actually has to make. A generic list of four ADRs is
 * boilerplate; a list that only contains what this profile triggers is not.
 */
export function decisionsFor(plan, stack, style) {
  const { profile } = plan;
  const rows = [];
  const add = (id, decision, why, implies) => rows.push([id, decision, why, implies]);

  add('ADR-001', `Architecture: ${style.name}`, style.why, 'Boundaries are checked by an import rule in CI, not by review.');

  if (['web-app', 'api', 'agent', 'mobile', 'data-pipeline'].includes(profile.kind)) {
    add('ADR-002', `Persistence: ${stack.stack.db}`, 'Invariants that must hold across rows belong in the database, not only in code.', `Migration for ${profile.kind === 'data-pipeline' ? 'each stage output' : 'every schema change'} is forward-only with a restore step.`);
  }
  if (profile.traits.includes('auth') || profile.traits.includes('admin')) {
    add('ADR-003', 'Authorization: policy checked server-side, deny by default', 'Client-side checks are hints, not controls; the server is the only caller that cannot be edited.', 'Every read and write takes an actor, and the policy test is written before the handler.');
  }
  if (profile.traits.includes('payments') || profile.risks.payments) {
    add('ADR-004', 'Money: integer minor units, immutable ledger entries', 'Floating point rounding and edited history are the two ways payment systems lose money.', 'Corrections are compensating entries; the balance is derived, never stored.');
  }
  if (profile.risks.multiTenant) {
    add('ADR-005', 'Tenancy: tenant key resolved server-side and applied in the data layer', 'A tenant filter applied at call sites is forgotten exactly once, and that once is an incident.', 'Every query goes through the scoped repository; a forged tenant id is rejected before any read.');
  }
  if (profile.traits.includes('realtime')) {
    add('ADR-006', 'Realtime transport: one ordering guarantee, stated', 'Realtime failures are ordering failures far more often than delivery failures.', 'Every event carries a sequence; the client reconciles on reconnect rather than assuming.');
  }
  if (profile.traits.includes('upload')) {
    add('ADR-007', 'Uploads: generated names, allowlisted types, metadata stripped', 'Public upload is the most common way a small product gets compromised.', 'Storage sits outside anything the web server executes; serving goes through signed URLs.');
  }
  if (profile.traits.includes('offline')) {
    add('ADR-008', 'Offline writes: local-first queue, exactly-once replay', 'A write the interface confirmed must not vanish, and must not apply twice.', 'Each queued write carries a client id used for de-duplication on replay.');
  }
  if (profile.traits.includes('ai') || profile.kind === 'agent') {
    add('ADR-009', 'Model calls: contract in, validated out, budgeted', 'A model call is an untrusted dependency that can be slow, wrong and expensive at once.', 'Every call has a timeout, a schema check on the response, and a per-task cost cap.');
  }
  if (profile.kind === 'data-pipeline') {
    add('ADR-010', 'Replay semantics: watermark per stage, idempotent output', 'A pipeline you cannot safely re-run is a pipeline you cannot fix.', 'Rerunning a window replaces its output rather than appending to it.');
  }
  return rows;
}

/**
 * One line per selected practice saying what it means *here*. The predicate
 * explains why the practice applies at all; this explains what it changes in this
 * product, which is the part an agent can act on.
 */
/**
 * A gate is policy, so its statement is the same for every project at a tier. What is
 * *not* the same is what passing it means here: how many requirements, which database,
 * which journey. That concrete reading is what the checklist shows.
 */
export function gateReading(gate, plan, words) {
  const primary = words[0] ?? 'record';
  const db = String(stackFor(plan.profile).stack.db).split(/[(+]/)[0].trim();
  const automated = plan.requirements.filter((requirement) => requirement.verify === 'automated').length;
  const manual = plan.requirements.filter((requirement) => requirement.verify === 'manual').length;
  return {
    'G0-RUN': `for ${titleize(plan.profile.name).replace(/^\d+\s*/, '')}: one command, and a missing variable is named`,
    'G0-SMOKE': `one ${primary} taken from creation to done through the documented interface`,
    'G1-DOMAIN-TESTS': `${plan.requirements.filter((requirement) => requirement.render === 'core').length} core requirements, each with a test on the ${primary} rules`,
    'G1-AC-TRACE': `${automated} automated requirements, ${manual} manual — anchor in the test file, not the doc`,
    'G2-CONTRACTS': `${plan.requirements.filter((requirement) => ['api', 'data'].includes(requirement.render)).length} interface requirements, shapes fixed in 04-contracts.md`,
    'G2-MIGRATIONS': `forward-only ${db} migration plus the restore step you actually ran`,
    'G3-MUTATION': `score recorded against the ${primary} domain layer, ratcheted in CI`,
    'G3-PROPERTY': `the ${primary} invariants, generated inputs rather than hand-picked examples`
  }[gate.id];
}

export function practiceCards(plan, phrases = new Map()) {
  // Which requirements a document governs, so a practice can be bound to the
  // actual obligations in this packet rather than to a filename that is the same
  // in every packet.
  const inDoc = (doc) => {
    if (doc === '05-verification.md') {
      return plan.requirements.filter((requirement) => requirement.verify === 'automated').map((requirement) => requirement.id);
    }
    if (doc === '02-domain-model.md') {
      return plan.requirements
        .filter((requirement) => ['core', 'data', 'security'].includes(requirement.render))
        .map((requirement) => requirement.id);
    }
    if (doc === '07-agent-handoff.md' || doc === 'AGENTS.md') {
      return [plan.requirements[0]?.id, plan.requirements[1]?.id].filter(Boolean);
    }
    return plan.requirements
      .filter((requirement) => {
        const target = AREA_DOCUMENT[requirement.render] ?? '01-product-brief.md';
        return target === doc || (doc === '01-product-brief.md' && requirement.render === 'core');
      })
      .map((requirement) => requirement.id);
  };

  return plan.primitives.map((primitive) => {
    const enforces = (primitive.enforces ?? [])
      .map((key) => plan.requirements.find((requirement) => requirement.key === key))
      .filter(Boolean);

    let bindTo;
    if (enforces.length > 0) {
      const [first, ...rest] = enforces;
      bindTo = `${first.id} ${phrases.get(first.key) ?? first.title}${rest.length > 0 ? ` (and ${rest.length} more)` : ''}`;
    } else if (primitive.artifacts?.length) {
      const doc = primitive.artifacts[0];
      const ids = inDoc(doc);
      const gates = (primitive.gates ?? []).map((gate) => gate.id).filter(Boolean);
      bindTo = ids.length > 0
        ? `\`${doc}\` — ${ids.slice(0, 3).join(', ')}${ids.length > 3 ? `, +${ids.length - 3}` : ''}`
        : gates.length > 0
          ? `\`${doc}\` — ${gates.join(', ')}`
          : `\`${doc}\``;
    } else {
      bindTo = 'the whole packet';
    }

    return {
      id: primitive.id,
      title: primitive.title,
      bindTo,
      because: primitive.why
    };
  });
}

// ---------- whole-packet derivation ----------

export { articleFor };
/** The short label of the database, without the migration tooling in brackets. */
export const dbLabel = (profile) => String(stackFor(profile).stack.db).split(/[(+]/)[0].trim();

export function derive(plan) {
  const contexts = contextsFor(plan.profile);
  const aggregates = aggregatesFor(plan.requirements);
  // Invariants the domain model already states count as coverage: the idea's
  // rule is in the packet even when no requirement carries it.
  const domainText = aggregates
    .map((aggregate) => `${aggregate.name} ${(aggregate.invariants ?? []).join(' ')}`)
    .join(' ');
  const vocab = vocabularyFor(plan.profile);
  const nouns = vocab.candidates;
  const words = nouns.map((entry) => (typeof entry === 'string' ? entry : entry.word));
  const phrases = phrasesFor(plan, words);
  return {
    project: titleize(plan.profile.name),
    // "Clinic Bookings' own rules", not "04 Clinic Bookings's own rules".
    projectPossessive: (() => {
      const name = titleize(plan.profile.name).replace(/^\d+\s*/, '');
      return /s$/i.test(name) ? `${name}'` : `${name}'s`;
    })(),
    // The product's own vocabulary, so a document can name the thing it is talking
    // about instead of saying "the record".
    words,
    // The product's nouns, always safe to use in a sentence. `vocabSource` says
    // whether they came from the idea or from what its kind implies, so a document
    // can be honest when the idea gave us nothing to name.
    primary: vocab.primary,
    secondary: vocab.secondary,
    secondaryPlural: vocab.secondaryPlural,
    primaryPlural: vocab.primaryPlural,
    aPrimary: vocab.aPrimary,
    aSecondary: `${articleFor(vocab.secondary)} ${vocab.secondary}`,
    vocabSource: vocab.source,
    db: dbLabel(plan.profile),
    contexts,
    terms: termsFor(plan.requirements),
    aggregates,
    groups: groupRequirements(plan.requirements),
    nonGoals: nonGoalsFor(plan.profile, words),
    questions: openQuestionsFor(plan.profile, plan.rigor, words),
    stack: stackFor(plan.profile),
    commands: commandsFor(plan.profile),
    phases: buildPhases(plan, phrases),
    brief: copyBrief(plan),
    style: styleFor(plan.profile),
    nouns,
    surfaces: surfacesFor(plan),
    ownRules: ownRulesFor(plan.profile),
    decisions: decisionsFor(plan, stackFor(plan.profile), styleFor(plan.profile)),
    cards: practiceCards(plan, phrases),
    phrases,
    start: firstOpenRequirement(plan),
    unmapped: unmappedObligations(plan.profile, plan.requirements, domainText),
    anchors: new Map(plan.requirements.map((requirement) => [requirement.id, anchorPath(plan.profile, requirement)]))
  };
}
