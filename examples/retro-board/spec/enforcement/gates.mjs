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
 *
 * What this is: a structural check per gate, so a gate is a command rather than a
 * sentence. What this is not: proof. Each gate says what it proves and what it does
 * not; a check that passes on a repository that ignores the gate is worse than no
 * check, so the rules are deliberately blunt and the gaps are named in `mechanism`.
 *
 * No dependencies, by design: this file is copied into repositories that do not
 * have this tool installed.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
    "mechanism": "The README itself. This check only proves a command is written down; G0-SMOKE proves it works."
  },
  "G0-CHECK": {
    "check": {
      "kind": "ci",
      "patterns": [
        "lint|typecheck|tsc|ruff|eslint|golangci|clippy",
        "pull_request"
      ]
    },
    "how": "A CI workflow runs a lint or typecheck step on pull requests.",
    "mechanism": "The workflow file. Add the same command to the README so a local run matches CI."
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
    "mechanism": "One end-to-end test, exercising the documented interface rather than the internals."
  },
  "G1-CI": {
    "check": {
      "kind": "ci",
      "patterns": [
        "test|pytest|go test|vitest|jest|rspec|dotnet test"
      ]
    },
    "how": "A CI workflow runs the test command.",
    "mechanism": "The workflow file, plus a branch protection rule that makes the job required. The rule is in the forge, not in the repository."
  },
  "G1-DOMAIN-TESTS": {
    "check": {
      "kind": "anchors",
      "scope": "core"
    },
    "how": "Every core requirement carries an @req anchor in a test file.",
    "mechanism": "`spec-check.mjs` counts the anchors; this gate fails while a core requirement has none."
  },
  "G1-AC-TRACE": {
    "check": {
      "kind": "anchors",
      "scope": "automated"
    },
    "how": "Every requirement marked automated has a test anchor.",
    "mechanism": "`spec-check.mjs --strict`, run in CI."
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
    "mechanism": "Three headings. A runbook with none of them is a README for the author."
  },
  "G1-SECRETS": {
    "check": {
      "kind": "no-secrets"
    },
    "how": "No credential-shaped string is committed, and a gitleaks config is present for the pre-commit hook.",
    "mechanism": "The runner scans the working tree; gitleaks scans history. Both are needed: this file cannot see what was already committed and deleted."
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
const REPO = path.resolve(option('--repo', process.cwd()));

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor', '.next', '.nuxt', '.venv', 'venv', '__pycache__', 'target', '.turbo']);
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|kt|cs|php|rs|sh|yml|yaml|json|toml|tf|exs|env|ini|conf)$/;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|e2e)\//i;

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
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(REPO);
const relative = files.map((file) => path.relative(REPO, file).split(path.sep).join('/'));
const globToRegExp = (glob) =>
  new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '(?:.*/)?')}$`
  );
const matchers = new Map();
const matches = (glob) => {
  if (!matchers.has(glob)) matchers.set(glob, globToRegExp(glob));
  return matchers.get(glob);
};
const pick = (globs) => relative.filter((file) => globs.some((glob) => matches(glob).test(file)));
const read = (file) => {
  try {
    return readFileSync(path.join(REPO, file), 'utf8');
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

/** Requirement ids proven by a test file carrying an @req anchor. */
function anchored() {
  const found = new Map();
  for (const file of relative) {
    if (!SOURCE.test(file)) continue;
    const text = read(file);
    if (!text.includes('@req')) continue;
    const isTest = TEST_PATH.test(file) || /\.(test|spec)\.[a-z]+$/i.test(file) || /(^|\/)test_[^/]+\.py$/i.test(file);
    for (const line of text.split('\n')) {
      if (!line.includes('@req')) continue;
      const match = line.match(/@req\s+(REQ-\d{3})/);
      if (!match) continue;
      if (!found.has(match[1])) found.set(match[1], []);
      found.get(match[1]).push({ file, isTest });
    }
  }
  return found;
}

const SECRET = [
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  /(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/,
  /sk-(?:live|test)?[A-Za-z0-9]{24,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /(?:password|secret|token|api[_-]?key)\s*[:=]\s*['"][^'"\s]{16,}['"]/i
];
const SECRET_ALLOW = /(?:<|\.\.\.|example|placeholder|dummy|redacted|your[_-]?|xxx+|changeme|process\.env|os\.environ)/i;

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
    case 'ci': {
      const workflows = relative.filter((file) => /^\.github\/workflows\/.*\.ya?ml$/.test(file) || /^(\.gitlab-ci\.yml|\.circleci\/config\.yml|azure-pipelines\.yml|Jenkinsfile)$/.test(file));
      if (workflows.length === 0) return { status: 'fail', detail: 'no CI configuration in the repository' };
      const ok = workflows.filter((file) => matchesAll(read(file), rule.patterns));
      return ok.length > 0 ? { status: 'pass', detail: ok.join(', ') } : { status: 'fail', detail: `${workflows.length} pipeline file(s), none matching` };
    }
    case 'anchors': {
      if (!spec) return { status: 'fail', detail: 'spec.json is not readable from the enforcement directory' };
      const map = anchored();
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
      const checker = path.join(PACKET, 'spec-check.mjs');
      if (!existsSync(checker)) return { status: 'fail', detail: 'spec-check.mjs is missing from the packet' };
      if (!existsSync(path.join(PACKET, 'spec.json'))) return { status: 'fail', detail: 'spec.json is missing from the packet' };
      const docs = spec?.docs ?? [];
      const missingDocs = docs.filter((doc) => !existsSync(path.join(PACKET, doc)));
      if (missingDocs.length > 0) return { status: 'fail', detail: `missing documents: ${missingDocs.join(', ')}` };
      const map = anchored();
      const pending = (spec?.requirements ?? []).filter(
        (requirement) => requirement.verify === 'automated' && !(map.get(requirement.id) ?? []).some((hit) => hit.isTest)
      );
      return pending.length > 0
        ? { status: 'pending', detail: `${pending.length} requirement(s) still unanchored; run node spec-check.mjs --repo .` }
        : { status: 'pass', detail: 'anchors resolve and every document is present' };
    }
    case 'attest': {
      const file = path.join(REPO, rule.file);
      if (!existsSync(file)) return { status: 'fail', detail: `no ${rule.file}; copy enforcement/templates/${rule.file} into place and fill it in` };
      const text = read(rule.file);
      const missing = (rule.requires ?? []).filter((token) => !new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text));
      return missing.length === 0
        ? { status: 'pass', detail: rule.file }
        : { status: 'fail', detail: `${rule.file} is missing ${missing.join(', ')}` };
    }
    case 'no-secrets': {
      const hits = [];
      for (const file of relative) {
        if (!SOURCE.test(file) && !/\.env/.test(file)) continue;
        if (/\.(lock|min|map)$/.test(file)) continue;
        const text = read(file);
        for (const line of text.split('\n')) {
          if (SECRET_ALLOW.test(line)) continue;
          if (SECRET.some((pattern) => pattern.test(line))) hits.push(`${file}: ${line.trim().slice(0, 60)}`);
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

const gates = (spec?.gates ?? []).map((gate) => gate.id);
const results = gates.map((id) => {
  const rule = RULES[id];
  if (!rule) return { id, status: 'fail', detail: 'no enforcement mechanism declared for this gate', how: '', mechanism: '' };
  return { id, ...check(rule.check), how: rule.how, mechanism: rule.mechanism };
});

const shown = path.relative(process.cwd(), REPO);
const summary = {
  repo: !shown || shown.startsWith('..') ? REPO : shown,
  gates: results.length,
  pass: results.filter((entry) => entry.status === 'pass').length,
  fail: results.filter((entry) => entry.status === 'fail').length,
  pending: results.filter((entry) => entry.status === 'pending').length,
  results
};

if (JSON_OUT) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`\ngate-runner · ${summary.gates} gates · repo ${summary.repo}\n`);
  for (const entry of results) {
    const symbol = entry.status === 'pass' ? '✓' : entry.status === 'fail' ? '✗' : '•';
    console.log(`${symbol} ${entry.id.padEnd(18)} ${entry.detail}`);
    if (entry.status === 'fail' && entry.how) console.log(`  ${' '.repeat(18)} ${entry.how}`);
  }
  if (STRICT && summary.pending > 0) {
    console.log(`\n✗ --strict: ${summary.pending} gate(s) still pending`);
  }
  console.log(
    `\n${summary.fail === 0 && (!STRICT || summary.pending === 0) ? 'PASS' : 'FAIL'} · ` +
      `${summary.pass} pass · ${summary.fail} fail · ${summary.pending} pending\n`
  );
}

process.exitCode = summary.fail > 0 || (STRICT && summary.pending > 0) ? 1 : 0;
