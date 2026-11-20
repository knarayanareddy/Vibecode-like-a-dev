#!/usr/bin/env node
/**
 * gate-runner.mjs — one executable check per gate.
 *
 * Generated into every specification packet by vibecode-like-a-dev, from
 * factory/gates/gates.json. Commit it with the packet and run it in CI.
 *
 *   node enforcement/gates.mjs                 # check this repository
 *   node enforcement/gates.mjs --repo ../app   # check another checkout
 *   node enforcement/gates.mjs --strict        # pending gates fail too
 *   node enforcement/gates.mjs --json          # machine-readable
 *   node enforcement/gates.mjs --phase 2       # gates after milestone 2 are advisory
 *   node enforcement/gates.mjs --baseline --owner @team --expires 2027-01-31
 *                                              # accept today's failures as debt with
 *                                              # an owner and an expiry; later runs
 *                                              # fail only on regressions or expiry
 *   node enforcement/gates.mjs --baseline-file .vld/other.json   # non-default record
 *
 * What this is: a structural check per gate, so a gate is a command rather than a
 * sentence. What this is not: proof. Each gate says what it proves and what it does
 * not; a check that passes on a repository that ignores the gate is worse than no
 * check, so the rules are deliberately blunt and the gaps are named in `mechanism`.
 *
 * No dependencies, by design: this file is copied into repositories that do not
 * have this tool installed.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, lstatSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKET = path.resolve(HERE, '..');
const RULES = {
  "G0-RUN": {
    "check": {
      "kind": "contains",
      "glob": [
        "README.md",
        "README",
        "readme.md"
      ],
      "patterns": [
        "```"
      ]
    },
    "how": "The README contains a fenced command block a new contributor can copy.",
    "mechanism": "The README itself. This check only proves a command is written down; G0-SMOKE proves it works.",
    "phase": 0
  },
  "G0-CHECK": {
    "check": {
      "kind": "ci",
      "patterns": [
        "lint|typecheck|tsc|biome|ruff|flake8|mypy|pyright|eslint|golangci|go vet|staticcheck|clippy|cargo check|rubocop|phpstan|psalm|flutter analyze|dart analyze|credo|dialyzer",
        "pull_request"
      ]
    },
    "how": "A CI workflow runs a lint or typecheck step on pull requests.",
    "mechanism": "The workflow file. Add the same command to the README so a local run matches CI.",
    "phase": 0
  },
  "G0-SMOKE": {
    "check": {
      "kind": "exists",
      "glob": [
        "**/*smoke*",
        "**/*e2e*",
        "**/*journey*",
        "**/e2e/**/*",
        "**/tests/**/*journey*"
      ]
    },
    "how": "A smoke or end-to-end test file exists for the primary journey.",
    "mechanism": "One end-to-end test, exercising the documented interface rather than the internals.",
    "phase": 0
  },
  "G1-CI": {
    "check": {
      "kind": "ci",
      "patterns": [
        "test|pytest|go test|vitest|jest|rspec|dotnet test|phpunit|gradle|mvn"
      ]
    },
    "how": "A CI workflow runs the test command.",
    "mechanism": "The workflow file, plus a branch protection rule that makes the job required. The rule is in the forge, not in the repository.",
    "phase": 0
  },
  "G1-DOMAIN-TESTS": {
    "check": {
      "kind": "anchors",
      "scope": "core"
    },
    "how": "Every core requirement carries an @req anchor in a test file.",
    "mechanism": "`spec-check.mjs` counts the anchors; this gate fails while a core requirement has none.",
    "phase": 1
  },
  "G1-AC-TRACE": {
    "check": {
      "kind": "anchors",
      "scope": "automated"
    },
    "how": "Every requirement marked automated has a test anchor.",
    "mechanism": "`spec-check.mjs --strict`, run in CI.",
    "phase": 1
  },
  "G1-RUNBOOK": {
    "check": {
      "kind": "contains",
      "glob": [
        "README.md",
        "README",
        "readme.md"
      ],
      "patterns": [
        "(?i)(run|start|develop)",
        "(?i)test",
        "(?i)deploy|release|ship"
      ]
    },
    "how": "The README covers running, testing and deploying.",
    "mechanism": "Three headings. A runbook with none of them is a README for the author.",
    "phase": 2
  },
  "G1-SECRETS": {
    "check": {
      "kind": "no-secrets"
    },
    "how": "No credential-shaped string is committed, and a gitleaks config is present for the pre-commit hook.",
    "mechanism": "The runner scans the working tree; gitleaks scans history. Both are needed: this file cannot see what was already committed and deleted.",
    "phase": 0
  },
  "G1-INCIDENT": {
    "check": {
      "kind": "attest",
      "file": "docs/runbook.md",
      "requires": [
        "owner",
        "escalation",
        "diagnostic"
      ]
    },
    "how": "docs/runbook.md names an owner, an escalation channel and first-response steps.",
    "mechanism": "The runbook file. This proves the fields are present, not that the named person knows the product; the three diagnostic steps are the part to read.",
    "phase": 2
  }
};

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 || index === args.length - 1 ? fallback : args[index + 1];
};

const STRICT = flag('--strict');
const JSON_OUT = flag('--json');
// Roadmap P2.4 & P2.5: executable gates (`G0-RUN`, `G0-CHECK`, `G0-SMOKE`,
// `G2-MUTATION`, `G3-MUTATION`) run real bounded checks by default and report
// `PASS-EXECUTED`. `--static-only` skips subprocess execution and labels every
// gate `PASS-STATIC` / `SKIPPED-STATIC-ONLY` so static scans never masquerade
// as executed proof. `--require-executed` blocks on `SKIPPED-UNAVAILABLE` too.
const STATIC_ONLY = flag('--static-only');
const REQUIRE_EXECUTED = flag('--require-executed');
const MUTATION_REPORT_OPT = option('--mutation-report', null);
// Adoption is incremental. Without a phase the runner is a wall of red on day one,
// and a team that cannot pass anything deletes the runner. `--phase N` makes gates
// after milestone N advisory; `--baseline` records today's failures with an owner
// and an expiry, and afterwards only breaks on a regression or an expired waiver.
const PHASE = option('--phase', null);
// `--baseline` takes no value: accepting one made `--baseline --owner x` write to a
// file literally named `--owner`. The path is a separate option.
const WRITE_BASELINE = flag('--baseline');
const BASELINE_PATH = option('--baseline-file', null);
const BASELINE_FILE = '.vld/gates-baseline.json';
// The evaluator may run spec-check itself inside a read-only Node Permission
// Model process. In that bounded harness it passes this internal hand-off flag
// so the gate runner does not need child-process permission merely to repeat it.
const DRIFT_ALREADY_CHECKED = flag('--drift-already-checked');
const CAN_EXECUTE = !STATIC_ONLY && !DRIFT_ALREADY_CHECKED && !process.permission && process.env.VLD_GATE_ACTIVE !== '1';
function defaultRepoRoot(packetDir) {
  const cwd = path.resolve(process.cwd());
  const packet = path.resolve(packetDir);
  if (cwd !== packet) return cwd;
  let cursor = packet;
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(path.join(cursor, '.git'))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return packet;
}

const REPO = path.resolve(option('--repo', defaultRepoRoot(PACKET)));

// Scan all committed product directories. Only Git metadata, dependency trees and
// language caches are excluded; credentials often hide in generated-looking or
// uncommon-extension files.
const IGNORED = new Set(['node_modules', '.git', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.turbo']);
// Anchor semantics must match the shipped spec checker and factory verifier.
// Configuration files may quote @req in fixtures or metadata; they are not source
// evidence and must not create a stray-anchor failure in only the gate runner.
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|kt|cs|php|rs|sh|feature|exs)$/;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|e2e)\//i;
const TEST_NAME = /\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(py|go|rb|rs|exs)$|Tests?\.(java|kt|cs|php)$/;
const ANCHOR_LINE = /@req\s+(REQ-(?:C\d{2,}|\d{3,}))/g;
const SUPPRESSED = /@req-ignore/i;
const ASSERTION_SIGNAL = /\b(?:assert[A-Za-z0-9_.]*|expect\s*\(|should\b|require\.[A-Z]\w*|t\.(?:Fatal|Fatalf|Error|Errorf|Fail|FailNow)|pytest\.raises|raises\s*\(|rejects\b|throws\b)\b|!==|===|!=|==|<=|>=/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (IGNORED.has(entry)) continue;
    const full = path.join(dir, entry);
    let stats;
    try {
      stats = lstatSync(full);
    } catch {
      continue;
    }
    // Never follow repository links: scans must neither escape their root nor loop.
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      if (full !== REPO && full !== PACKET && existsSync(path.join(full, 'profile.json')) && (existsSync(path.join(full, 'spec', 'spec.json')) || existsSync(path.join(full, 'specs', 'spec.json')))) continue;
      walk(full, out);
    }
    else out.push(full);
  }
  return out;
}

const files = walk(REPO);
const relative = files.map((file) => path.relative(REPO, file).split(path.sep).join('/'));
// Exclude the packet directory itself (e.g. `specs/`) and `changes/` deltas from
// repository checks so `specs/spec.json`, `changes/*/spec.after.json` or shipped
// enforcement skeletons never self-satisfy a gate meant for the product repository.
const packetRel = path.relative(REPO, PACKET).split(path.sep).join('/');
const packetInsideRepo = packetRel && !packetRel.startsWith('..') && !path.isAbsolute(packetRel);
const isPacketOrDelta = (file) =>
  (packetInsideRepo && (file === packetRel || file.startsWith(`${packetRel}/`))) ||
  file === 'changes' ||
  file.startsWith('changes/');
const repoFiles = relative.filter((file) => !isPacketOrDelta(file));

const globToRegExp = (glob) =>
  new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '\u0000')
      .replace(/\*\*/g, '\u0001')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '(?:.*/)?')
      .replace(/\u0001/g, '.*')}$`
  );
const matchers = new Map();
const matches = (glob) => {
  if (!matchers.has(glob)) matchers.set(glob, globToRegExp(glob));
  return matchers.get(glob);
};
const pick = (globs) => repoFiles.filter((file) => globs.some((glob) => matches(glob).test(file)));
const read = (file) => {
  try {
    const bytes = readFileSync(path.join(REPO, file));
    // Do not treat arbitrary binaries as text, but do inspect every textual
    // extension/name rather than relying on a narrow source allowlist.
    return bytes.includes(0) ? '' : bytes.toString('utf8');
  } catch {
    return '';
  }
};

/** Patterns are written for humans: a leading "(?i)" is accepted and ignored. */
const toRegExp = (pattern) => new RegExp(pattern.replace(/^\(\?i\)/, ''), 'i');
const matchesAll = (text, patterns) => patterns.every((pattern) => toRegExp(pattern).test(text));

let spec = null;
try {
  spec = JSON.parse(readFileSync(path.join(PACKET, 'spec.json'), 'utf8'));
} catch {
  spec = null;
}

/** Requirement ids proven by source/test markers, matching the shipped drift guard. */
function anchored() {
  const found = new Map();
  const stray = [];
  const known = new Set((spec?.requirements ?? []).map((requirement) => requirement.id));
  const exclusions = Array.isArray(spec?.anchors?.exclude) ? spec.anchors.exclude : [];
  const exclusionPatterns = exclusions.map(globToRegExp);
  for (const file of repoFiles) {
    if (!SOURCE.test(file) || exclusionPatterns.some((pattern) => pattern.test(file))) continue;
    const text = read(file);
    if (!text.includes('@req')) continue;
    const isTest = TEST_PATH.test(file) || TEST_NAME.test(file);
    for (const line of text.split('\n')) {
      if (!line.includes('@req') || SUPPRESSED.test(line)) continue;
      for (const match of line.matchAll(ANCHOR_LINE)) {
        const id = match[1];
        if (!known.has(id)) {
          stray.push(`${file} cites unknown requirement ${id}`);
          continue;
        }
        if (!found.has(id)) found.set(id, []);
        found.get(id).push({ file, isTest });
      }
    }
  }
  return { found, stray };
}

/**
 * Strip fenced code blocks, inline code spans, and markdown blockquotes before
 * inspecting attestation prose (`OpenSpec` code-fence masking pattern), so command
 * examples like ``npm i pkg@<previous>`` never trigger unfilled-template errors.
 */
function stripCodeAndQuotes(markdown) {
  return String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(/^[ \t]*>.*$/gm, '');
}

function unfilledPlaceholder(markdown) {
  const prose = stripCodeAndQuotes(markdown);
  const angle = prose.match(/<[a-z][^>\n]{2,}>/i);
  if (angle) return angle[0];
  if (/\bYYYY-MM-DD\b/.test(prose)) return 'YYYY-MM-DD';
  const todo = prose.match(/(?:^|[:|])[ \t]*(TODO|TBD)\b/m);
  if (todo) return todo[1];
  return null;
}

const SECRET = [
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  /(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/,
  /sk-(?:live|test)?[A-Za-z0-9]{24,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /(?:password|secret|token|api[_-]?key)\s*[:=]\s*['"][^'"\s]{16,}['"]/i
];
// A fixture allowance must name the exact inert value, not an unrelated word on
// the source line. Broad line-wide exemptions turn comments such as "example" or
// punctuation such as "<" into a bypass for a real credential.
const SECRET_PLACEHOLDER_VALUES = new Set([
  'changeme-placeholder',
  'example-auth-material',
  'parent-secret-must-not-reach-child'
]);
function maskExplicitSecretPlaceholders(line) {
  // Mask only the exact inert assignment value. Never exempt the whole source
  // line: minified/object-literal code can contain a real credential beside a
  // fixture placeholder.
  return line.replace(/((?:password|secret|token|api[_-]?key)\s*[:=]\s*['"])([^'"\s]+)(['"])/gi, (match, prefix, value, suffix) =>
    SECRET_PLACEHOLDER_VALUES.has(value) ? `${prefix}[placeholder]${suffix}` : match
  );
}

function check(rule) {
  switch (rule.kind) {
    case 'exists': {
      const hits = pick(rule.glob);
      return hits.length > 0
        ? { status: 'pass', detail: hits.slice(0, 3).join(', ') }
        : { status: 'fail', detail: `none of: ${rule.glob.join(', ')}` };
    }
    case 'contains': {
      const hits = pick(rule.glob);
      if (hits.length === 0) return { status: 'fail', detail: `no file matching ${rule.glob.join(' or ')}` };
      const ok = hits.filter((file) => matchesAll(read(file), rule.patterns));
      return ok.length > 0
        ? { status: 'pass', detail: ok.slice(0, 3).join(', ') }
        : { status: 'fail', detail: `${hits.length} file(s) matched, none contained all of ${rule.patterns.length} pattern(s)` };
    }
    case 'semantic-oracles': {
      const configs = pick(rule.mutationGlob ?? []);
      const pythonConfig = pick(rule.pythonGlob ?? []).some((file) => (rule.pythonPatterns ?? []).some((pattern) => new RegExp(pattern, 'i').test(read(file))));
      const packetConfig = existsSync(path.join(PACKET, 'enforcement', 'mutation.config.json'));
      if (configs.length === 0 && !pythonConfig && !packetConfig) return { status: 'fail', detail: 'no mutation configuration was found beside semantic oracles' };
      const file = path.join(REPO, rule.config ?? 'semantic-oracles.json');
      let manifest;
      try { manifest = JSON.parse(readFileSync(file, 'utf8')); } catch { return { status: 'fail', detail: `missing or invalid ${rule.config ?? 'semantic-oracles.json'}` }; }
      if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.oracles)) return { status: 'fail', detail: `${rule.config ?? 'semantic-oracles.json'} needs schemaVersion 1 and an oracles list` };
      const expected = (spec?.requirements ?? []).filter((requirement) => requirement.verify === 'automated').map((requirement) => requirement.id);
      const byId = new Map();
      for (const oracle of manifest.oracles) if (oracle && typeof oracle.id === 'string' && typeof oracle.test === 'string' && !byId.has(oracle.id)) byId.set(oracle.id, oracle.test);
      const missing = [];
      for (const id of expected) {
        const test = byId.get(id);
        if (!test || !rule.testGlob.some((glob) => matches(glob).test(test)) || !repoFiles.includes(test)) { missing.push(id); continue; }
        const source = read(test);
        if (!new RegExp(`@req\\s+${id}\\b`).test(source) || !ASSERTION_SIGNAL.test(source)) missing.push(id);
      }
      return missing.length === 0
        ? { status: 'pass', detail: `${expected.length} automated requirement(s) have separate semantic-oracle test evidence` }
        : { status: 'fail', detail: `missing independent semantic oracle evidence for ${missing.slice(0, 5).join(', ')}` };
    }
    case 'mutation': {
      const configs = pick(rule.glob ?? []);
      if (configs.length > 0) return { status: 'pass', detail: configs.slice(0, 3).join(', ') };
      const pyproject = pick(rule.pythonGlob ?? []);
      const configuredPython = pyproject.filter((file) => matchesAll(read(file), rule.pythonPatterns ?? []));
      if (configuredPython.length > 0) return { status: 'pass', detail: configuredPython.slice(0, 3).join(', ') };
      // The packet ships a pinned mutation configuration (the thresholds live in it).
      // A product repo that has not copied one out yet is still configured — by the
      // packet's own default, which `vld verify --mutation` runs against.
      const packetConfig = path.join(PACKET, 'enforcement', 'mutation.config.json');
      if (existsSync(packetConfig)) return { status: 'pass', detail: 'enforcement/mutation.config.json (packet-pinned default)' };
      return { status: 'fail', detail: 'no mutation configuration (Stryker, mutmut, Cosmic Ray, or packet config) was found' };
    }
    case 'ci': {
      const workflows = relative.filter((file) => /^\.github\/workflows\/.*\.ya?ml$/.test(file) || /^(\.gitlab-ci\.yml|\.circleci\/config\.yml|azure-pipelines\.yml|Jenkinsfile)$/.test(file));
      if (workflows.length === 0) return { status: 'fail', detail: 'no CI configuration in the repository' };
      const ok = workflows.filter((file) => matchesAll(read(file), rule.patterns));
      return ok.length > 0 ? { status: 'pass', detail: ok.join(', ') } : { status: 'fail', detail: `${workflows.length} pipeline file(s), none matching` };
    }
    case 'anchors': {
      if (!spec) return { status: 'fail', detail: 'spec.json is not readable from the enforcement directory' };
      const { found: map, stray } = anchored();
      if (stray.length > 0) return { status: 'fail', detail: stray.slice(0, 3).join(' | ') };
      // Only automated requirements can carry a test anchor. A requirement verified by
      // a gate (`verify: "gate"`) or by a person (`verify: "manual"`) would otherwise
      // sit in this list forever, which trains everyone to ignore a permanent amber.
      const scope = (spec.requirements ?? []).filter(
        (requirement) => requirement.verify === 'automated' && (rule.scope !== 'core' || requirement.area === 'core')
      );
      const missing = scope.filter((requirement) => !(map.get(requirement.id) ?? []).some((hit) => hit.isTest));
      if (scope.length === 0) return { status: 'pass', detail: 'no requirement in scope' };
      const done = missing.filter((requirement) => String(requirement.status ?? 'todo') === 'done');
      if (done.length > 0) return { status: 'fail', detail: `${done.map((requirement) => requirement.id).join(', ')} marked done with no test anchor` };
      if (missing.length > 0) return { status: 'pending', detail: `${missing.length}/${scope.length} not yet anchored (${missing.slice(0, 3).map((requirement) => requirement.id).join(', ')})` };
      return { status: 'pass', detail: `${scope.length}/${scope.length} anchored in tests` };
    }
    case 'drift': {
      if (DRIFT_ALREADY_CHECKED) return { status: 'pass', detail: 'spec-check.mjs already passed in the bounded evaluator' };
      const checker = path.join(PACKET, 'spec-check.mjs');
      if (!existsSync(checker)) return { status: 'fail', detail: 'spec-check.mjs is missing from the packet' };
      if (!existsSync(path.join(PACKET, 'spec.json'))) return { status: 'fail', detail: 'spec.json is missing from the packet' };
      const docs = spec?.docs ?? [];
      const missingDocs = docs.filter((doc) => !existsSync(path.join(PACKET, doc)));
      if (missingDocs.length > 0) return { status: 'fail', detail: `missing documents: ${missingDocs.join(', ')}` };
      // Delegate final drift authority to the copied checker. It owns EARS,
      // unknown/source-only anchors, suppression, exclusions, and assertion
      // behavior; duplicating a subset here has repeatedly caused false greens.
      try {
        execFileSync(process.execPath, [checker, '--repo', REPO, '--strict'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
      } catch {
        return { status: 'fail', detail: 'spec-check.mjs failed; run node spec-check.mjs --repo . for findings' };
      }
      return { status: 'pass', detail: 'spec-check.mjs validates anchors and every document is present' };
    }
    case 'attest': {
      const file = path.join(REPO, rule.file);
      if (!existsSync(file)) return { status: 'fail', detail: `no ${rule.file}; copy enforcement/templates/${rule.file} into place and fill it in` };
      const text = read(rule.file);
      const missing = (rule.requires ?? []).filter((token) => !new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text));
      if (missing.length > 0) return { status: 'fail', detail: `${rule.file} is missing ${missing.join(', ')}` };
      const placeholder = unfilledPlaceholder(text);
      if (placeholder) {
        return { status: 'fail', detail: `${rule.file} still contains unfilled template placeholder (${placeholder})` };
      }
      return { status: 'pass', detail: rule.file };
    }
    case 'no-secrets': {
      const hits = [];
      for (const file of repoFiles) {
        const text = read(file);
        for (const [index, line] of text.split('\n').entries()) {
          const inspected = maskExplicitSecretPlaceholders(line);
          if (SECRET.some((pattern) => pattern.test(inspected))) hits.push(`${file}:${index + 1} (credential-shaped value redacted)`);
        }
      }
      return hits.length === 0
        ? { status: 'pass', detail: `${relative.length} files scanned, no credential-shaped strings` }
        : { status: 'fail', detail: `${hits.length} suspected secret(s): ${hits.slice(0, 3).join(' | ')}` };
    }
    default:
      return { status: 'fail', detail: `unknown check kind "${rule.kind}"` };
  }
}

// Roadmap P2.3, P2.4 & P2.5: bounded gate execution helpers.
function scrubbedGateEnv() {
  const safe = { CI: '1', NO_COLOR: '1', VLD_GATE_ACTIVE: '1', PYTHONDONTWRITEBYTECODE: '1' };
  for (const k of ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'LANG', 'LC_ALL', 'GOPATH', 'GOCACHE', 'CARGO_HOME', 'RUSTUP_HOME']) {
    if (process.env[k]) safe[k] = process.env[k];
  }
  return safe;
}

function runGateCmd(argv, { timeoutMs = 45_000 } = {}) {
  const t0 = Date.now();
  // Node >= 22.20 refuses direct spawn of .cmd/.bat (CVE-2024-27980 mitigation)
  // with EINVAL; route them through cmd.exe with a quoted command line instead.
  const isWinShim = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(argv[0]);
  const [cmd, cmdArgs] = isWinShim
    ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', argv.map((a) => (/^[A-Za-z0-9_./:\\-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '\\"')}"`)).join(' ')]]
    : [argv[0], argv.slice(1)];
  const res = spawnSync(cmd, cmdArgs, {
    cwd: REPO,
    env: scrubbedGateEnv(),
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const durationMs = Date.now() - t0;
  if (res.error) {
    const code = res.error.code;
    if (code === 'ENOENT') {
      return { state: 'unavailable', durationMs, command: argv.join(' '), detail: `tool "${argv[0]}" is not installed` };
    }
    if (code === 'ETIMEDOUT') {
      return { state: 'fail', durationMs, command: argv.join(' '), detail: `command timed out after ${timeoutMs}ms: ${argv.join(' ')}` };
    }
    return { state: 'fail', durationMs, command: argv.join(' '), detail: `${argv.join(' ')} failed: ${res.error.message}` };
  }
  if (res.status === 0) {
    return { state: 'pass', durationMs, command: argv.join(' '), detail: `executed \`${argv.join(' ')}\` (${durationMs}ms, exit 0)` };
  }
  const snippet = String(res.stderr || res.stdout || '').trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 180);
  return {
    state: 'fail',
    durationMs,
    command: argv.join(' '),
    detail: `\`${argv.join(' ')}\` failed with exit ${res.status}${snippet ? `: ${snippet}` : ''}`
  };
}

function readRepoPkg() {
  const p = path.join(REPO, 'package.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

const npmBin = () => (process.platform === 'win32' ? 'npm.cmd' : 'npm');

function executeG0Run() {
  const pkg = readRepoPkg();
  if (pkg) {
    if (pkg.scripts?.build) return runGateCmd([npmBin(), 'run', '--silent', 'build']);
    if (pkg.scripts?.['verify:run']) return runGateCmd([npmBin(), 'run', '--silent', 'verify:run']);
    const entry = typeof pkg.bin === 'string'
      ? pkg.bin
      : (pkg.bin && typeof pkg.bin === 'object' ? Object.values(pkg.bin)[0] : pkg.main);
    if (typeof entry === 'string' && /\.(?:m|c)?js$/.test(entry) && existsSync(path.join(REPO, entry))) {
      return runGateCmd([process.execPath, '--check', entry]);
    }
  }
  if (existsSync(path.join(REPO, 'go.mod'))) {
    return runGateCmd(['go', 'build', './...']);
  }
  const pyFiles = relative.filter((f) => f.endsWith('.py') && !TEST_PATH.test(f) && !TEST_NAME.test(f)).slice(0, 8);
  if (pyFiles.length > 0) {
    return runGateCmd(['python3', '-m', 'py_compile', ...pyFiles]);
  }
  return null;
}

function executeG0Check() {
  const pkg = readRepoPkg();
  if (pkg) {
    if (pkg.scripts?.lint) return runGateCmd([npmBin(), 'run', '--silent', 'lint']);
    if (pkg.scripts?.typecheck) return runGateCmd([npmBin(), 'run', '--silent', 'typecheck']);
    if (pkg.scripts?.check) return runGateCmd([npmBin(), 'run', '--silent', 'check']);
  }
  if (existsSync(path.join(REPO, 'tsconfig.json'))) {
    const localTsc = path.join(REPO, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
    if (existsSync(localTsc)) return runGateCmd([localTsc, '--noEmit']);
  }
  if (existsSync(path.join(REPO, 'go.mod'))) {
    return runGateCmd(['go', 'vet', './...']);
  }
  return null;
}

async function probeHttpSmoke(cfg) {
  const cmd = Array.isArray(cfg.command) ? cfg.command.map(String) : null;
  if (!cmd || cmd.length === 0) return { state: 'fail', detail: '.vld/smoke.json missing command array' };
  const expectStatus = Number(cfg.expectStatus ?? 200);
  const timeoutMs = Math.min(30_000, Math.max(1000, Number(cfg.timeoutMs ?? 8000)));
  if (!cfg.healthUrl) {
    return runGateCmd(cmd, { timeoutMs });
  }
  const t0 = Date.now();
  const child = spawn(cmd[0], cmd.slice(1), {
    cwd: REPO,
    env: scrubbedGateEnv(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let exited = null;
  let stderrBuf = '';
  child.stderr.on('data', (c) => { if (stderrBuf.length < 400) stderrBuf += c.toString('utf8'); });
  child.on('exit', (code) => { exited = code ?? 1; });
  const deadline = t0 + timeoutMs;
  let lastStatus = null;
  let lastErr = null;
  try {
    while (Date.now() < deadline) {
      if (exited !== null) {
        return { state: 'fail', durationMs: Date.now() - t0, detail: `smoke server exited early (${exited}): ${stderrBuf.trim().slice(0, 140)}` };
      }
      const res = await new Promise((resolve) => {
        const req = http.get(cfg.healthUrl, { timeout: 1000 }, (r) => {
          r.resume();
          resolve({ status: r.statusCode ?? 0 });
        });
        req.on('error', (e) => resolve({ err: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ err: 'timeout' }); });
      });
      if (res.status === expectStatus) {
        return { state: 'pass', durationMs: Date.now() - t0, detail: `executed smoke probe ${cfg.healthUrl} -> HTTP ${res.status} (${Date.now() - t0}ms)` };
      }
      if (res.status && res.status >= 500) {
        return { state: 'fail', durationMs: Date.now() - t0, detail: `smoke probe ${cfg.healthUrl} returned HTTP ${res.status} (expected ${expectStatus})` };
      }
      lastStatus = res.status ?? lastStatus;
      lastErr = res.err ?? lastErr;
      await new Promise((r) => setTimeout(r, 120));
    }
    return {
      state: 'fail',
      durationMs: Date.now() - t0,
      detail: `smoke probe ${cfg.healthUrl} failed after ${timeoutMs}ms (${lastStatus ? `HTTP ${lastStatus}` : lastErr || 'unreachable'})`
    };
  } finally {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  }
}

async function executeG0Smoke() {
  const smokeCfgPath = path.join(REPO, '.vld', 'smoke.json');
  if (existsSync(smokeCfgPath)) {
    let cfg;
    try { cfg = JSON.parse(readFileSync(smokeCfgPath, 'utf8')); } catch (e) {
      return { state: 'fail', detail: `invalid .vld/smoke.json: ${e.message}` };
    }
    return probeHttpSmoke(cfg);
  }
  const pkg = readRepoPkg();
  if (pkg?.scripts?.smoke) {
    return runGateCmd([npmBin(), 'run', '--silent', 'smoke']);
  }
  if (existsSync(path.join(REPO, 'enforcement', 'smoke.sh'))) {
    return runGateCmd(['bash', path.join(REPO, 'enforcement', 'smoke.sh')]);
  }
  // Execute dedicated Node smoke test file if present
  const jsSmoke = relative.filter((f) => /smoke.*\.(?:test|spec)\.(?:m|c)?js$/i.test(f));
  if (jsSmoke.length > 0) {
    return runGateCmd([process.execPath, '--test', ...jsSmoke.slice(0, 3)]);
  }
  // Execute CLI `--version` smoke check if package declares a `bin`
  if (pkg?.bin) {
    const binRel = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0];
    if (typeof binRel === 'string' && existsSync(path.join(REPO, binRel))) {
      return runGateCmd([process.execPath, binRel, '--version']);
    }
  }
  return null;
}

function inspectMutationReport(tier) {
  const threshold = Number(tier ?? 0) >= 3 ? 0.75 : 0.60;
  const candidates = MUTATION_REPORT_OPT
    ? [path.resolve(MUTATION_REPORT_OPT)]
    : [
        path.join(REPO, '.vld', 'reports', 'mutation-report.json'),
        path.join(REPO, 'reports', 'mutation', 'mutation.json'),
        path.join(REPO, 'gremlins-report.json'),
        path.join(REPO, 'mutants.out', 'outcomes.json')
      ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    if (MUTATION_REPORT_OPT) {
      return { state: 'fail', detail: `mutation report not found: ${MUTATION_REPORT_OPT}` };
    }
    return { state: 'missing', threshold };
  }
  let doc;
  try { doc = JSON.parse(readFileSync(found, 'utf8')); } catch (e) {
    return { state: 'fail', detail: `invalid mutation report ${path.basename(found)}: ${e.message}` };
  }
  if (doc.verdictLabel === 'SKIPPED-UNAVAILABLE') {
    return { state: 'unavailable', threshold, detail: doc.reason || 'mutation runner unavailable on host' };
  }
  if (doc.verdictLabel === 'WAIVED') {
    return { state: 'waived', threshold, detail: `mutation gate waived until ${doc.waiver?.expires}: ${doc.waiver?.reason}` };
  }
  let killed = Number(doc.killed ?? 0);
  let survived = Number(doc.survived ?? 0);
  if (doc.kind !== 'vld-mutation-report') {
    killed = 0;
    survived = 0;
    if (doc.files && !Array.isArray(doc.files)) {
      for (const info of Object.values(doc.files)) {
        for (const m of info?.mutants ?? []) {
          if (['Killed', 'Timeout', 'CompileError'].includes(m.status)) killed += 1;
          else if (['Survived', 'NoCoverage'].includes(m.status)) survived += 1;
        }
      }
    } else if (Array.isArray(doc.files)) {
      for (const f of doc.files) {
        for (const m of f?.mutations ?? []) {
          const st = String(m.status ?? '').toUpperCase();
          if (st === 'KILLED' || st === 'TIMED OUT') killed += 1;
          else if (st === 'LIVED' || st === 'NOT COVERED') survived += 1;
        }
      }
    } else if (Array.isArray(doc.outcomes)) {
      for (const o of doc.outcomes) {
        if (o.summary === 'CaughtMutant' || o.summary === 'Timeout') killed += 1;
        else if (o.summary === 'MissedMutant') survived += 1;
      }
    }
  }
  const total = killed + survived;
  const score = total > 0 ? killed / total : 0;
  const pct = (score * 100).toFixed(1);
  const reqPct = (threshold * 100).toFixed(0);
  if (total === 0) {
    return { state: 'fail', score: 0, threshold, detail: `mutation report ${path.basename(found)} recorded 0 evaluated mutants` };
  }
  if (score < threshold) {
    return { state: 'fail', score, threshold, detail: `mutation score ${pct}% (${killed}/${total} killed) < required ${reqPct}% tier-${tier} floor` };
  }
  return { state: 'pass', score, threshold, detail: `executed mutation score ${pct}% (${killed}/${total} killed) >= ${reqPct}% floor` };
}

const gates = (spec?.gates ?? []).map((gate) => gate.id);
const specTier = Number(spec?.rigor?.tier ?? 1);

// Phase selection: a gate whose milestone is later than the requested phase is
// advisory. It is still evaluated and still printed, so nothing is hidden; it just
// does not fail the run.
const phaseLimit = PHASE === null ? null : Number.parseInt(PHASE, 10);
if (PHASE !== null && (!Number.isInteger(phaseLimit) || phaseLimit < 0)) {
  console.error(`gate-runner: --phase expects a milestone 0-5, got "${PHASE}"`);
  process.exit(2);
}

const results = [];
for (const id of gates) {
  const rule = RULES[id];
  if (!rule) {
    results.push({ id, status: 'fail', verdictLabel: 'FAIL', mode: 'static', detail: 'no enforcement mechanism declared for this gate', how: '', mechanism: '', phase: 0 });
    continue;
  }
  let outcome = check(rule.check);
  let mode = rule.check?.kind === 'attest' ? 'manual' : (rule.check?.kind === 'drift' && CAN_EXECUTE ? 'executed' : 'static');
  let verdictLabel = outcome.status === 'pass'
    ? (mode === 'executed' ? 'PASS-EXECUTED' : 'PASS-STATIC')
    : outcome.status === 'pending'
      ? 'MANUAL'
      : 'FAIL';

  // P2.4: Execute G0-RUN, G0-CHECK, G0-SMOKE when not in --static-only mode!
  if (outcome.status === 'pass' && (id === 'G0-RUN' || id === 'G0-CHECK' || id === 'G0-SMOKE')) {
    if (STATIC_ONLY) {
      mode = 'static';
      verdictLabel = 'SKIPPED-STATIC-ONLY';
      outcome = { ...outcome, detail: `${outcome.detail} [static-only — execution skipped]` };
    } else if (CAN_EXECUTE) {
      const execRes = id === 'G0-RUN'
        ? executeG0Run()
        : id === 'G0-CHECK'
          ? executeG0Check()
          : await executeG0Smoke();
      if (execRes) {
        if (execRes.state === 'pass') {
          mode = 'executed';
          verdictLabel = 'PASS-EXECUTED';
          outcome = { status: 'pass', detail: `${outcome.detail} · ${execRes.detail}`, durationMs: execRes.durationMs };
        } else if (execRes.state === 'unavailable') {
          mode = 'skipped';
          verdictLabel = 'SKIPPED-UNAVAILABLE';
          outcome = {
            status: REQUIRE_EXECUTED ? 'fail' : 'pass',
            detail: `${outcome.detail} · SKIPPED-UNAVAILABLE (${execRes.detail})`
          };
        } else {
          mode = 'executed';
          verdictLabel = 'FAIL';
          outcome = { status: 'fail', detail: execRes.detail, durationMs: execRes.durationMs };
        }
      } else if (REQUIRE_EXECUTED) {
        mode = 'skipped';
        verdictLabel = 'SKIPPED-UNAVAILABLE';
        outcome = { status: 'fail', detail: `${id}: no executable command configured (--require-executed)` };
      }
    }
  }

  // P2.3: Verify executed mutation score on G2-MUTATION (>=60%) and G3-MUTATION (>=75%)!
  if (id === 'G2-MUTATION' || id === 'G3-MUTATION') {
    const mut = inspectMutationReport(id === 'G3-MUTATION' ? Math.max(3, specTier) : Math.max(2, specTier));
    if (mut.state === 'pass') {
      mode = 'executed';
      verdictLabel = 'PASS-EXECUTED';
      outcome = {
        status: outcome.status === 'fail' && !MUTATION_REPORT_OPT ? 'fail' : 'pass',
        detail: outcome.status === 'pass' ? `${outcome.detail} · ${mut.detail}` : mut.detail,
        mutationScore: mut.score,
        mutationThreshold: mut.threshold
      };
    } else if (mut.state === 'waived') {
      mode = 'waived';
      verdictLabel = 'WAIVED';
      outcome = { status: 'pass', detail: mut.detail };
    } else if (mut.state === 'fail') {
      mode = 'executed';
      verdictLabel = 'FAIL';
      outcome = { status: 'fail', detail: mut.detail, mutationScore: mut.score ?? 0, mutationThreshold: mut.threshold };
    } else if (mut.state === 'unavailable') {
      mode = 'skipped';
      verdictLabel = 'SKIPPED-UNAVAILABLE';
      outcome = {
        status: REQUIRE_EXECUTED ? 'fail' : outcome.status,
        detail: `${outcome.detail} · SKIPPED-UNAVAILABLE (${mut.detail})`
      };
    } else if (mut.state === 'missing' && REQUIRE_EXECUTED && !STATIC_ONLY) {
      mode = 'skipped';
      verdictLabel = 'SKIPPED-UNAVAILABLE';
      outcome = {
        status: 'fail',
        detail: `${id}: no executed mutation report found (requires >= ${Math.round(mut.threshold * 100)}% killed; run \`vld verify --run --mutation\` or add a dated waiver)`
      };
    } else if (outcome.status === 'pass' && STATIC_ONLY) {
      verdictLabel = 'SKIPPED-STATIC-ONLY';
    }
  }

  const phase = typeof rule.phase === 'number' ? rule.phase : 0;
  const outOfPhase = phaseLimit !== null && phase > phaseLimit;
  const finalStatus = outOfPhase && outcome.status === 'fail' ? 'deferred' : outcome.status;
  results.push({
    id,
    ...outcome,
    status: finalStatus,
    verdictLabel: finalStatus === 'deferred' ? 'DEFERRED' : verdictLabel,
    mode,
    actual: outcome.status,
    phase,
    how: rule.how,
    mechanism: rule.mechanism
  });
}

// Baseline: a recorded failure is debt, not a regression. The record carries an
// owner and an expiry so it cannot become a permanent waiver by neglect.
const baselinePath = path.resolve(REPO, BASELINE_PATH ?? BASELINE_FILE);
let baseline = null;
if (existsSync(baselinePath)) {
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch (error) {
    console.error(`gate-runner: ${baselinePath} is not valid JSON — ${error.message}`);
    process.exit(2);
  }
}
const today = new Date().toISOString().slice(0, 10);
const waivers = new Map();
if (baseline && Array.isArray(baseline.gates)) {
  for (const entry of baseline.gates) {
    if (entry && typeof entry.id === 'string') waivers.set(entry.id, entry);
  }
}
const accepted = [];
const expired = [];
for (const entry of results) {
  if (entry.status !== 'fail') continue;
  const waiver = waivers.get(entry.id);
  if (!waiver) continue;
  if (typeof waiver.expires === 'string' && waiver.expires < today) {
    expired.push({ ...entry, owner: waiver.owner, expires: waiver.expires });
    continue;
  }
  accepted.push({ ...entry, owner: waiver.owner ?? 'unassigned', expires: waiver.expires ?? 'no expiry' });
}

const shown = path.relative(process.cwd(), REPO);
for (const entry of results) {
  if (accepted.some((w) => w.id === entry.id)) {
    entry.verdictLabel = 'WAIVED';
  }
}
const blocking = results.filter((entry) => entry.status === 'fail' && !accepted.some((waived) => waived.id === entry.id));
const executedPass = results.filter((entry) => entry.verdictLabel === 'PASS-EXECUTED').length;
const staticPass = results.filter((entry) => entry.verdictLabel === 'PASS-STATIC' || entry.verdictLabel === 'SKIPPED-STATIC-ONLY').length;
const skippedUnavailable = results.filter((entry) => entry.verdictLabel === 'SKIPPED-UNAVAILABLE').length;
const pendingCount = results.filter((entry) => entry.status === 'pending').length;
const overallVerdict = blocking.length > 0 || (STRICT && pendingCount > 0)
  ? 'FAIL'
  : STATIC_ONLY
    ? 'STATIC-ONLY'
    : pendingCount > 0
      ? 'INCOMPLETE'
      : executedPass > 0
        ? 'EXECUTED-PASS'
        : 'STATIC-PASS';
const summary = {
  repo: !shown || shown.startsWith('..') ? REPO : shown,
  mode: STATIC_ONLY ? 'static-only' : (CAN_EXECUTE ? 'executed' : 'static-bounded'),
  verdict: overallVerdict,
  gates: results.length,
  pass: results.filter((entry) => entry.status === 'pass').length,
  executedPass,
  staticPass,
  skippedUnavailable,
  fail: blocking.length,
  pending: pendingCount,
  deferred: results.filter((entry) => entry.status === 'deferred').length,
  accepted: accepted.length,
  acceptedIds: accepted.map((entry) => entry.id),
  expired: expired.length,
  phase: phaseLimit,
  results
};

// --baseline writes today's state as the accepted starting point. It never invents
// a waiver for a gate that passes, and it keeps the owner/expiry of an existing
// entry so re-running does not silently renew debt.
if (WRITE_BASELINE) {
  const target = path.resolve(REPO, BASELINE_PATH ?? BASELINE_FILE);
  const kept = [];
  for (const entry of results) {
    if (entry.status !== 'fail' && entry.status !== 'deferred') continue;
    const previous = waivers.get(entry.id);
    kept.push({
      id: entry.id,
      owner: previous?.owner ?? option('--owner', 'unassigned'),
      expires: previous?.expires ?? option('--expires', defaultExpiry()),
      reason: previous?.reason ?? option('--reason', 'present when the baseline was taken'),
      recorded: previous?.recorded ?? today
    });
  }
  const payload = {
    comment: 'Accepted gate debt. A gate listed here is a known gap with an owner and an expiry, not a passing gate: this file never turns a failure into a pass, it only stops an already-failing gate from failing the build twice. Remove an entry when the gate passes.',
    recorded: today,
    repo: summary.repo,
    gates: kept
  };
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
  if (!JSON_OUT) console.log(`\nbaseline written: ${path.relative(process.cwd(), target)} · ${kept.length} gate(s) accepted with an owner and an expiry\n`);
}

function defaultExpiry() {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  return date.toISOString().slice(0, 10);
}

if (JSON_OUT) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  if (STATIC_ONLY) {
    console.error('\n⚠ STATIC-ONLY MODE (--static-only): executable gates were not run. Static checks cannot certify release readiness.\n');
  }
  console.log(`\ngate-runner · ${summary.gates} gates · mode ${summary.mode} · repo ${summary.repo}\n`);
  for (const entry of results) {
    const symbol = entry.status === 'pass' ? '✓' : entry.status === 'fail' ? '✗' : '•';
    const badge = entry.verdictLabel ? `[${entry.verdictLabel}] ` : '';
    console.log(`${symbol} ${entry.id.padEnd(18)} ${badge}${entry.detail}`);
    if (entry.status === 'fail' && entry.how) console.log(`  ${' '.repeat(18)} ${entry.how}`);
  }
  if (STRICT && summary.pending > 0) {
    console.log(`\n✗ --strict: ${summary.pending} gate(s) still pending`);
  }
  // Waivers are printed with their owner and expiry on every run: debt that is
  // invisible is debt nobody pays down.
  for (const entry of accepted) {
    console.log(`  • ${entry.id.padEnd(18)} accepted until ${entry.expires} · owner ${entry.owner}`);
  }
  for (const entry of expired) {
    console.log(`  ✗ ${entry.id.padEnd(18)} waiver expired ${entry.expires} · owner ${entry.owner}`);
  }
  if (summary.deferred > 0) {
    console.log(`\n  ${summary.deferred} gate(s) belong to a later milestone than phase ${phaseLimit}; they are reported, not enforced. Run without --phase to require all of them.`);
  }
  console.log(
    `\n${summary.fail === 0 && (!STRICT || summary.pending === 0) ? 'PASS' : 'FAIL'} · ` +
      `${summary.pass} pass · ${summary.fail} fail · ${summary.pending} pending` +
      `${summary.deferred ? ` · ${summary.deferred} deferred` : ''}` +
      `${summary.accepted ? ` · ${summary.accepted} accepted` : ''}\n`
  );
}

// Recording the baseline is the act of accepting the current state, so it exits 0
// even though the gates it recorded are red. The next run is the one that judges.
process.exitCode = WRITE_BASELINE ? 0 : summary.fail > 0 || (STRICT && summary.pending > 0) ? 1 : 0;
