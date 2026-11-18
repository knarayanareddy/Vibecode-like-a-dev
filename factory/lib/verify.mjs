/**
 * Packet verification.
 *
 * This is the difference between a spec and a wish. It checks the packet is
 * internally complete, that every gate required by the tier is present, that
 * quoted primitives still exist, that the packet respects its own size budget,
 * and — given a repository — that automated requirements are actually anchored
 * to tests that exist.
 *
 * Exit semantics are ratcheted on purpose: an unfinished requirement is a
 * warning, a finished requirement without proof is an error.
 */

import { existsSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { analyzeScopedAssertion } from '../../packages/analysis/src/index.mjs';
import { ANCHOR_PLACEMENT_MESSAGE, detectTestLanguage, resolveAnchorScope } from './anchor-scope.mjs';
import { earsError } from './ears.mjs';
import { loadIndex } from './indexer.mjs';
import { loadPolicy } from './planner.mjs';
import { matchAnchorExecution, parseTestReport } from './test-report.mjs';

/** Roadmap P2.5: honest verification verdict hierarchy (never calls anchors "verified"). */
export const VERIFICATION_VERDICTS = Object.freeze([
  'failed',
  'structurally-valid',
  'anchored-only',
  'static-asserted',
  'executed-verified',
  'mutation-verified'
]);

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', 'target', '.turbo'
]);

const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|kt|cs|php|rs|sh|feature|exs)$/;
const TEST_FILE = /(^|\/)(tests?|__tests__|specs?)\//;
const TEST_NAME = /\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(py|go|rb|rs|exs)$|_spec\.rb$|Tests?\.(java|kt|cs|php)$/;
const ANCHOR_LINE = /@req\s+(REQ-(?:\d{3,}|C\d{2,}))/g;
const REQUIREMENT_ID = /^REQ-(?:\d{3,}|C\d{2,})$/;
const SUPPRESSED = /@req-ignore/i;
const CLARIFY_MARKER = /\[(?:CLARIFY|NEEDS CLARIFICATION)(?::[^\]]*)?\]/i;
// Keep this deliberately lexical and mirror it in the dependency-free checker
// emitted into packets. It detects a hollow anchored test; it does not claim a
// mutation score or semantic proof.
const ASSERTION_SIGNAL =
  /^[ \t]*assert\s+\S|\b(?:assert\s*!?\s*\(|assert_[a-z0-9_]+\s*!?\s*\(|assert\.[A-Za-z_]\w*\s*\(|assert[A-Z]\w*\s*\(|Assert\.[A-Z]\w*\s*\(|refute(?:_\w+)?\b|expect\s*\(|should\b|require\.[A-Z]\w*\s*\(|t\.(?:Fatal|Fatalf|Error|Errorf|Fail|FailNow)\b|pytest\.raises|raises\s*\(|rejects\b|throws\b)|!==|===|!=|==|<=|>=/m;

const JS_TEST_INFRA =
  /^(?:node:(?:test|assert)(?:\/|$)|(?:@jest\/globals|vitest|jest|mocha|chai|ava|tap|uvu|sinon|@testing-library\/[\w-]+|@playwright\/test|playwright|supertest|fast-check)(?:\/|$))/;
const PY_TEST_INFRA =
  /^(?:pytest|_\w*pytest|pytest_\w+|unittest|hypothesis|freezegun|responses|respx|faker|factory|typing|typing_extensions|__future__|dataclasses)(?:\.|$)/;
const RUST_NON_PRODUCT =
  /^(?:std|core|alloc|test|proptest|quickcheck|rstest|pretty_assertions|insta|criterion|mockall|wiremock|serial_test)(?:::|$)/;
const JVM_NON_PRODUCT =
  /^(?:org\.junit|junit|org\.testng|org\.assertj|org\.hamcrest|org\.mockito|io\.mockk|io\.kotest|kotlin\.test|net\.jqwik|java|javax|kotlin|kotlinx\.coroutines\.test)(?:\.|$)/;
const PHP_NON_PRODUCT =
  /^\\?(?:PHPUnit|Pest|Mockery|Prophecy|Faker|Eris|Hamcrest)(?:\\|$)/i;
const RUBY_NON_PRODUCT =
  /^(?:rspec|minitest|test\/unit|spec_helper|rails_helper|test_helper|minitest_helper|webmock|vcr|factory_bot|faker|rantly|json|yaml|time|date|set|ostruct|fileutils|tmpdir|pathname|securerandom)(?:\/|$)/;
const CSHARP_NON_PRODUCT =
  /^(?:System|Xunit|NUnit|Microsoft\.VisualStudio\.TestTools|FluentAssertions|Moq|NSubstitute|FakeItEasy|AutoFixture|FsCheck)(?:\.|$)/;
const GO_NON_PRODUCT =
  /^(?:testing(?:\/\w+)?|fmt|time|os|io|bytes|strings|strconv|context|sync|errors|math|sort|reflect|regexp|path(?:\/filepath)?|encoding\/\w+|net(?:\/http(?:\/httptest)?)?|github\.com\/stretchr\/testify(?:\/[\w-]+)?|pgregory\.net\/rapid)$/;

export function reachesProductCode(source, filePath = '') {
  const ext = path.extname(String(filePath)).toLowerCase();
  if (ext === '.py') {
    for (const rawLine of source.split('\n')) {
      const line = rawLine.replace(/#.*$/, '').trim();
      if (!line) continue;
      const fromMatch = /^from\s+(\.+[\w.]*|[\w.]+)\s+import\s+.+$/.exec(line);
      if (fromMatch) {
        if (fromMatch[1].startsWith('.') || !PY_TEST_INFRA.test(fromMatch[1])) return true;
        continue;
      }
      const importMatch = /^import\s+(.+)$/.exec(line);
      if (importMatch) {
        const mods = importMatch[1].split(',').map((part) => part.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
        if (mods.some((mod) => !PY_TEST_INFRA.test(mod))) return true;
      }
    }
    return false;
  }
  if (ext === '.rs') {
    for (const match of source.matchAll(/^\s*(?:pub\s+)?use\s+((?:crate|super|self)(?:::\S+)?|[a-zA-Z_]\w*(?:::[\w*{},\s]+)?)\s*;/gm)) {
      const target = match[1].trim().replace(/^::/, '');
      if (/^(?:crate|super|self)(?:::|$)/.test(target)) return true;
      const root = target.split('::')[0];
      if (root && !RUST_NON_PRODUCT.test(target) && !RUST_NON_PRODUCT.test(root)) return true;
    }
    for (const match of source.matchAll(/^\s*extern\s+crate\s+([a-zA-Z_]\w*)\s*;/gm)) {
      if (!RUST_NON_PRODUCT.test(match[1])) return true;
    }
    return false;
  }
  if (ext === '.java' || ext === '.kt') {
    for (const match of source.matchAll(/^\s*import\s+(?:static\s+)?([A-Za-z_][\w.]*(?:\.\*)?)\s*;?/gm)) {
      if (!JVM_NON_PRODUCT.test(match[1])) return true;
    }
    return false;
  }
  if (ext === '.php') {
    for (const match of source.matchAll(/^\s*use\s+(?:function\s+|const\s+)?(\\?[A-Za-z_]\w*(?:\\[A-Za-z_]\w*)+)(?:\s+as\s+\w+)?\s*;/gm)) {
      if (!PHP_NON_PRODUCT.test(match[1])) return true;
    }
    for (const match of source.matchAll(/\b(?:require|require_once|include|include_once)\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"]+)['"]/gm)) {
      if (!/vendor\/autoload\.php$/i.test(match[1]) && !/bootstrap/i.test(match[1])) return true;
    }
    return false;
  }
  if (ext === '.rb') {
    for (const match of source.matchAll(/^\s*require_relative\s*\(?\s*['"]([^'"]+)['"]\s*\)?/gm)) {
      const target = match[1].replace(/^\.\//, '');
      if (!/^(?:\.\.\/)*(?:spec_helper|rails_helper|test_helper|minitest_helper)(?:\.rb)?$/.test(target)) return true;
    }
    for (const match of source.matchAll(/^\s*require\s*\(?\s*['"]([^'"]+)['"]\s*\)?/gm)) {
      const target = match[1];
      if (target.startsWith('./') || target.startsWith('../')) {
        if (!/(?:spec_helper|rails_helper|test_helper|minitest_helper)(?:\.rb)?$/.test(target)) return true;
        continue;
      }
      if (/^(?:lib|app|config\/environment)\//.test(target)) return true;
      if (!RUBY_NON_PRODUCT.test(target) && target.includes('/')) return true;
    }
    return false;
  }
  if (ext === '.go') {
    const imports = [];
    for (const single of source.matchAll(/^\s*import\s+(?:[\w.]+\s+)?["']([^"']+)["']/gm)) imports.push(single[1]);
    for (const block of source.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)) {
      for (const line of block[1].matchAll(/["']([^"']+)["']/g)) imports.push(line[1]);
    }
    if (imports.some((spec) => !GO_NON_PRODUCT.test(spec))) return true;
    const pkg = /^\s*package\s+([A-Za-z_]\w*)/m.exec(source)?.[1];
    if (!pkg || pkg.endsWith('_test') || pkg === 'test' || pkg === 'tests') return false;
    const stripped = source
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/"(?:\\.|[^"\\])*"|`[^`]*`/g, '""')
      .replace(/\bfunc\s+Test\w*\s*\([^)]*\)/g, '')
      .replace(/\bt\.\w+\s*\(/g, '');
    return /\b[A-Za-z_]\w*\s*\(/.test(stripped) || /\b[A-Za-z_]\w*\s*\{/.test(stripped);
  }
  if (ext === '.cs') {
    for (const match of source.matchAll(/^\s*(?:global\s+)?using\s+(?:static\s+)?([A-Za-z_][\w.]*)\s*;/gm)) {
      if (!CSHARP_NON_PRODUCT.test(match[1])) return true;
    }
    return false;
  }
  if (ext === '.exs') {
    for (const match of source.matchAll(/^\s*(?:alias|import|use)\s+([A-Z][\w.]*)/gm)) {
      if (!/^ExUnit(?:\.|$)/.test(match[1])) return true;
    }
    return false;
  }
  if (ext === '.sh' || ext === '.feature') return true;
  const pattern = /(?:^\s*import\s[\s\S]*?\bfrom\s+|^\s*import\s+|(?:\brequire|\bimport)\s*\(\s*)['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(pattern)) {
    const spec = match[1];
    if (spec.startsWith('.') || spec.startsWith('@/') || spec.startsWith('~/') || spec.startsWith('/') || !JS_TEST_INFRA.test(spec)) return true;
  }
  return false;
}

/**
 * Which anchored requirements in one test file are not proven by their own test.
 *
 * Mirrors `scopedAssertionFor` in factory/templates/spec-check.mjs. The two
 * checkers must agree about the same file: `vld verify` and the dependency-free
 * checker a packet ships are both run in CI, and a rule that exists in only one
 * of them is a rule an agent can route around by running the other.
 *
 * A file-level "contains an assertion" test is satisfied by one real test
 * anywhere in the file, so ten hollow `@req` tests read as proven because a
 * neighbour asserted something. This scopes the signal to each anchor's test.
 * Where an anchor cannot be scoped individually the caller falls back to the
 * file-level signal, so this narrows a false pass rather than inventing one.
 */
function inspectAnchorScope(source, anchorIndex, filePath = '') {
  const scoped = resolveAnchorScope(source, anchorIndex, filePath);
  if (scoped.status === 'misplaced') {
    return {
      status: 'misplaced',
      hasAssertion: false,
      astValid: false,
      tautologyReason: null,
      testName: null,
      startLine: null,
      endLine: null,
      body: '',
      message: scoped.message
    };
  }
  const regexHasAssertion = ASSERTION_SIGNAL.test(scoped.body);
  const language = detectTestLanguage(filePath);
  const ast = analyzeScopedAssertion({
    language,
    scopeBody: scoped.body,
    fileSource: source,
    startLine: scoped.startLine ?? 1
  });
  // If the AST analyzer identifies an explicit tautology, reflexive comparison,
  // swallowed assertion, unreachable assertion, or uncoupled literal assertion,
  // reject it even if a regex matched `expect(` or `assert`! When it recognizes no
  // assertion shape at all (an unsupported or idiosyncratic language), the lexical
  // signal decides — mirroring the dependency-free checker shipped in packets.
  const firstBad = ast.findings?.[0] ?? null;
  const isSemanticFailure = !ast.valid && firstBad && firstBad.reason !== 'no-assertion';
  const hasGenuineAssertion = isSemanticFailure ? false : (ast.valid || regexHasAssertion);
  return {
    status: 'ok',
    hasAssertion: hasGenuineAssertion,
    astValid: hasGenuineAssertion,
    tautologyReason: isSemanticFailure ? `${firstBad.reason}: ${firstBad.detail}` : null,
    testName: scoped.testName,
    startLine: scoped.startLine ?? null,
    endLine: scoped.endLine ?? null,
    body: scoped.body,
    message: null
  };
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // `**/` means zero or more path components, while a remaining `**` may span
  // nested descendants (including the trailing `/**` form).
  return new RegExp(`^${escaped
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*')}$`);
}

const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');

function walk(dir, root, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (full === root) continue;
    let stats;
    try {
      stats = lstatSync(full);
    } catch {
      continue;
    }
    // Never follow repository links: scans must neither escape their root nor loop.
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      // Nested self-contained VLD projects (e.g. examples/case-studies/*) verify against their own spec.json.
      if (full !== root && existsSync(path.join(full, 'profile.json')) && (existsSync(path.join(full, 'spec', 'spec.json')) || existsSync(path.join(full, 'specs', 'spec.json')))) continue;
      walk(full, root, out);
    }
    else if (SOURCE_FILE.test(entry)) out.push(full);
  }
  return out;
}

export function scanAnchors(repoDir, { exclude = [] } = {}) {
  const anchors = new Map();
  const hollow = [];
  const stray = [];
  let scanned = 0;
  let suppressed = 0;
  const exclusionPatterns = exclude.map(globToRegExp);

  for (const file of walk(repoDir, repoDir)) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!source.includes('@req')) continue;
    scanned += 1;

    const relative = rel(repoDir, file);
    if (exclusionPatterns.some((pattern) => pattern.test(relative))) continue;

    const isTest = TEST_FILE.test(relative) || TEST_NAME.test(relative);
    const fileIds = [];
    // Requirements whose own anchored test carries no assertion (BLKR-04), a
    // tautological/swallowed/uncoupled assertion (P2.2), or no following test
    // declaration within 40 lines (roadmap P0.3).
    const unproven = new Set();
    const tautological = new Map();
    const misplaced = new Set();
    const sourceLines = source.split('\n');
    for (const [lineIndex, line] of sourceLines.entries()) {
      const matches = [...line.matchAll(ANCHOR_LINE)];
      if (matches.length === 0) continue;
      // A line that suppresses the marker is not an anchor: fixtures and examples
      // quote @req deliberately, and pretending otherwise creates false failures.
      if (SUPPRESSED.test(line)) {
        suppressed += matches.length;
        continue;
      }
      for (const match of matches) {
        const id = match[1];
        fileIds.push(id);
        let testName = null;
        let startLine = null;
        let endLine = null;
        let astValid = false;
        let scopedBody = '';
        if (isTest) {
          const scope = inspectAnchorScope(source, lineIndex, file);
          testName = scope.testName;
          startLine = scope.startLine;
          endLine = scope.endLine;
          astValid = scope.astValid;
          scopedBody = scope.body;
          if (scope.status === 'misplaced') misplaced.add(id);
          else if (scope.tautologyReason) tautological.set(id, scope.tautologyReason);
          else if (!scope.hasAssertion) unproven.add(id);
        }
        if (!anchors.has(id)) anchors.set(id, []);
        anchors.get(id).push({
          id,
          file: relative,
          line: lineIndex + 1,
          isTest,
          testName,
          startLine,
          endLine,
          astValid,
          body: scopedBody
        });
      }
    }
    if (isTest && fileIds.length > 0) {
      const ids = [...new Set(fileIds)];
      if (misplaced.size > 0) {
        hollow.push({
          file: relative,
          ids: [...misplaced].filter((id) => fileIds.includes(id)),
          reason: `no test declaration follows within 40 lines (${ANCHOR_PLACEMENT_MESSAGE})`,
          kind: 'misplaced-anchor'
        });
      }
      if (tautological.size > 0) {
        const byReason = new Map();
        for (const [id, reason] of tautological.entries()) {
          if (!byReason.has(reason)) byReason.set(reason, []);
          byReason.get(reason).push(id);
        }
        for (const [reason, rIds] of byReason.entries()) {
          hollow.push({
            file: relative,
            ids: rIds,
            reason: `tautological or non-observing assertion (${reason})`,
            kind: 'tautological-assertion'
          });
        }
      }
      // File-level first, then per requirement, and report missing product imports
      // distinctly so `vld verify` agrees with `spec-check.mjs`.
      if (!ASSERTION_SIGNAL.test(source) && misplaced.size === 0 && tautological.size === 0) {
        hollow.push({ file: relative, ids, reason: 'no assertion in the anchored test', kind: 'no-assertion' });
      } else if (unproven.size > 0) {
        hollow.push({ file: relative, ids: [...unproven].filter((id) => fileIds.includes(id)), reason: 'no assertion in the anchored test', kind: 'no-assertion' });
      }
      if (!reachesProductCode(source, file)) hollow.push({ file: relative, ids, reason: 'the test does not import product code', kind: 'no-import' });
    }
  }

  return { anchors, hollow, stray, scanned, suppressed };
}

export function verifyPacket(
  packetDir,
  {
    repo = null,
    strict = false,
    requireAssertions = false,
    testReport = null,
    reportPath = null,
    requireReport = false,
    mutationReport = null,
    policy = loadPolicy()
  } = {}
) {
  const errors = [];
  const warnings = [];
  const passes = [];
  const info = [];

  const manifestPath = path.join(packetDir, 'spec.json');
  if (!existsSync(manifestPath)) {
    return { ok: false, errors: [`${packetDir} has no spec.json`], warnings, passes, info, stats: null };
  }

  let spec;
  try {
    spec = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { ok: false, errors: [`spec.json is not valid JSON: ${error.message}`], warnings, passes, info, stats: null };
  }

  if (spec.schemaVersion !== 1) errors.push(`spec.json schemaVersion is ${spec.schemaVersion}; expected 1`);

  const packetType = spec.rigor?.packet ?? 'full';
  const required = policy.requiredDocs[packetType] ?? policy.requiredDocs.full;

  // 1. documents
  for (const doc of required) {
    if (!existsSync(path.join(packetDir, doc))) errors.push(`missing required document: ${doc}`);
  }
  for (const doc of spec.docs ?? []) {
    if (!existsSync(path.join(packetDir, doc))) errors.push(`spec.json lists "${doc}" but it is not in the packet`);
  }
  if (errors.length === 0) passes.push(`all ${required.length} required documents present (${packetType} packet)`);

  // 2. size budget — the anti-ceremony rule, enforced per tier
  const markdown = readdirSync(packetDir).filter((file) => file.endsWith('.md') || file === 'spec.md');
  let lines = 0;
  for (const file of new Set(markdown)) {
    lines += readFileSync(path.join(packetDir, file), 'utf8').split('\n').length;
  }
  // 2b. trait coverage — every declared trait must change the packet.
  //
  // A trait is a promise that the compiler knows something about the product.
  // Four of thirteen traits had no catalog template at all, so declaring
  // `realtime` raised the tier and added nothing to build. Coverage is checked
  // against the manifest, which now records the traits each requirement
  // satisfies, so the check cannot be satisfied by prose.
  const requirementTraits = new Set();
  for (const requirement of spec.requirements ?? []) {
    for (const trait of requirement.traits ?? []) requirementTraits.add(trait);
  }
  const declaredTraits = Array.isArray(spec.project?.traits) ? spec.project.traits : [];
  const waivers = Array.isArray(spec.project?.traitWaivers) ? spec.project.traitWaivers : [];
  const waived = new Set(waivers.map((entry) => (typeof entry === 'string' ? entry : entry?.trait)).filter(Boolean));
  const uncovered = declaredTraits.filter((trait) => !requirementTraits.has(trait) && !waived.has(trait));
  for (const trait of uncovered) {
    errors.push(`trait ${trait} has no requirement. Declare an overlay, add a catalog template, or record a dated waiver in the profile (traitWaivers).`);
  }
  if (declaredTraits.length > 0 && uncovered.length === 0) {
    passes.push(`all ${declaredTraits.length} declared trait(s) are covered by a requirement${waived.size ? ` (${waived.size} waived)` : ''}`);
  }

  // 2c. budgets split by what a reader loads (BUG-7).
  //
  // The old ceiling was a single total over every stored document, so every extra
  // requirement competed with the same number and closing a coverage gap pushed the
  // packet over budget. But an agent never reads the whole packet: it loads
  // AGENTS.md before a task and one area document during it. So the entry point is
  // a hard ceiling, each on-demand document has a ceiling of its own, and the
  // stored total is reported as a warning that names where to split.
  const tierForBudget = spec.rigor?.tier ?? 0;
  const budget = policy.budgets.maxLinesByTier[String(tierForBudget)] ?? policy.budgets.maxLinesByTier['3'];
  const always = policy.budgets.alwaysRead ?? {};
  const entryFile = packetType === 'single-file' ? 'spec.md' : 'AGENTS.md';
  const entryLines = existsSync(path.join(packetDir, entryFile))
    ? readFileSync(path.join(packetDir, entryFile), 'utf8').split('\n').length
    : 0;
  // In a single-file packet there is no area document to move detail into: spec.md
  // is what the agent reads and what the packet stores, so the two budgets are the
  // same file and the stored reference is the binding one.
  const entryBudget = packetType === 'single-file'
    ? budget
    : (always.maxLinesByTier?.[String(tierForBudget)] ?? budget);
  info.push(`entry point: ${entryLines} lines of ${entryBudget} (${entryFile}, tier ${tierForBudget})`);
  if (entryLines > entryBudget) {
    errors.push(
      `${entryFile} is ${entryLines} lines, over the ${entryBudget}-line always-read budget for tier ${tierForBudget}. An agent loads this before every task: move detail into an area document instead of growing the entry point.`
    );
  } else {
    passes.push(`${entryFile} fits its ${entryBudget}-line always-read budget (${entryLines} lines)`);
  }

  const onDemandCap = always.maxOnDemandDocLines;
  const areaDocs = new Map();
  for (const file of new Set(markdown)) {
    if (file === entryFile) continue;
    const size = readFileSync(path.join(packetDir, file), 'utf8').split('\n').length;
    areaDocs.set(file, size);
  }
  if (typeof onDemandCap === 'number') {
    const oversized = [...areaDocs].filter(([, size]) => size > onDemandCap);
    for (const [file, size] of oversized) {
      errors.push(`${file} is ${size} lines, over the ${onDemandCap}-line ceiling for a single on-demand document. Split it by area rather than storing one document nobody finishes.`);
    }
    if (areaDocs.size > 0 && oversized.length === 0) {
      const largest = [...areaDocs].reduce((a, b) => (b[1] > a[1] ? b : a));
      passes.push(`every on-demand document is under ${onDemandCap} lines (largest: ${largest[0]} at ${largest[1]})`);
    }
  }

  // Token cost, not just lines: an agent pays for tokens, and the same paragraph is
  // 200 tokens or 400 depending on how much structure surrounds it. Roughly four
  // characters per token is the usual English estimate; it is reported as an
  // estimate so nobody quotes it as a measurement.
  const readFiles = [entryFile, ...areaDocs.keys()];
  const readChars = readFiles.reduce((total, file) => {
    const target = path.join(packetDir, file);
    return existsSync(target) ? total + readFileSync(target, 'utf8').length : total;
  }, 0);
  info.push(`reading cost: ~${Math.round(readChars / 4).toLocaleString('en-US')} tokens for the entry point plus every area document`);

  info.push(`packet size: ${lines} lines stored (tier ${tierForBudget} reference ${budget})`);
  if (lines > budget) {
    // Stored size is a review surface, not a reading surface: an author can split
    // it, but no requirement may be dropped to satisfy a number.
    warnings.push(
      `packet stores ${lines} lines, over the tier ${tierForBudget} reference of ${budget}. Nothing an agent reads is over budget; split the largest area (${[...areaDocs].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'none'}) into one document per area, or raise factory/policy.json budgets.maxLinesByTier with a reason.`
    );
  } else {
    passes.push(`packet fits its tier ${tierForBudget} stored reference (${lines} of ${budget} lines)`);
  }

  // 3. rigor and gates
  const tier = spec.rigor?.tier;
  if (![0, 1, 2, 3].includes(tier)) errors.push(`rigor.tier must be 0-3 (got ${tier})`);

  const expectedGates = [];
  for (let t = 0; t <= (Number.isInteger(tier) ? tier : 0); t += 1) {
    expectedGates.push(...(policy.gates[String(t)] ?? []).filter((gate) => !gate.primitiveOnly));
  }
  const gateIds = new Set((spec.gates ?? []).map((gate) => gate.id));
  for (const gate of expectedGates) {
    if (!gateIds.has(gate.id)) errors.push(`gate ${gate.id} is required at tier ${tier} but missing from spec.json`);
  }
  if (expectedGates.length > 0 && expectedGates.every((gate) => gateIds.has(gate.id))) {
    passes.push(`all ${expectedGates.length} gates for tiers 0-${tier} present`);
  }

  // 3b. every gate is a command, not a sentence
  //
  // A gate with no mechanism is the failure this packet exists to prevent, so a
  // packet that lists gates but ships no runner is called out; one that ships a runner
  // which has lost a rule is an error, because the missing rule is silent at run time.
  const declared = (spec.gates ?? []).filter((gate) => gate.enforcement);
  const runner = spec.gates?.[0]?.enforcement?.runner ?? 'enforcement/gates.mjs';
  if (declared.length === 0) {
    warnings.push(`no gate has an executable mechanism; recompile with the current generator to get ${runner}`);
  } else {
    const runnerPath = path.join(packetDir, runner);
    if (!existsSync(runnerPath)) {
      errors.push(`spec.json declares ${runner} but the packet does not contain it`);
    } else {
      const source = readFileSync(runnerPath, 'utf8');
      const missing = (spec.gates ?? []).filter((gate) => !source.includes(`"${gate.id}"`)).map((gate) => gate.id);
      if (missing.length > 0) errors.push(`${runner} has no rule for ${missing.join(', ')}`);
      const fragments = [...new Set(declared.flatMap((gate) => gate.enforcement.files ?? []))];
      const absent = fragments.filter((file) => !existsSync(path.join(packetDir, file)));
      if (absent.length > 0) errors.push(`enforcement files declared but missing: ${absent.join(', ')}`);
      const uncovered = (spec.gates ?? []).filter((gate) => !gate.enforcement).map((gate) => gate.id);
      if (uncovered.length > 0) errors.push(`gate(s) with no mechanism: ${uncovered.join(', ')}`);
      if (missing.length === 0 && absent.length === 0) {
        passes.push(`${declared.length} gate(s) have an executable mechanism (${runner}${fragments.length ? ` + ${fragments.length} config fragment(s)` : ''})`);
      }
    }
  }

  // 4. requirements
  const requirements = Array.isArray(spec.requirements) ? spec.requirements : [];
  if (requirements.length === 0) errors.push('spec.json has no requirements');

  const known = new Set(requirements.map((requirement) => requirement.id));
  let criteria = 0;
  for (const requirement of requirements) {
    if (!REQUIREMENT_ID.test(requirement.id ?? '')) errors.push(`invalid requirement id "${requirement.id}"`);
    if (!requirement.statement || String(requirement.statement).length < 40) {
      errors.push(`${requirement.id}: statement missing or too thin`);
    } else {
      // EARS shape, enforced: the test generator, the reviewer and the gate all read
      // the same clauses, and none of them can do that with a run-on sentence.
      const ears = earsError(requirement.statement);
      if (ears) errors.push(`${requirement.id}: not an EARS requirement — ${ears}`);
    }
    if (!Array.isArray(requirement.acceptance) || requirement.acceptance.length === 0) {
      errors.push(`${requirement.id}: no acceptance criteria`);
    } else {
      criteria += requirement.acceptance.length;
    }
    const fullText = `${requirement.statement ?? ''} ${(requirement.acceptance ?? []).map((a) => (typeof a === 'string' ? a : a?.text ?? '')).join(' ')}`;
    if (CLARIFY_MARKER.test(fullText)) {
      if (strict) errors.push(`--strict: ${requirement.id} contains unresolved clarification marker(s)`);
      else warnings.push(`${requirement.id} contains unresolved clarification marker(s) — resolve before release`);
    }
    if (!['automated', 'manual', 'gate'].includes(requirement.verify)) {
      errors.push(`${requirement.id}: verify must be automated, manual or gate`);
    }
    if (requirement.verify === 'automated' && !requirement.anchor) {
      errors.push(`${requirement.id}: automated requirement needs an anchor path`);
    }
  }

  // 3b. the idea against the requirements it selected.
  //
  // The packet shipped two contradictory rules and verify reported zero warnings:
  // the idea said a deleted clinic "must be recoverable for 30 days", while the
  // selected data-lifecycle requirement said deletion removes every copy "in one
  // operation". Nothing compared the two, so the agent would implement one and
  // fail the other.
  const idea = String(spec.project?.idea ?? '');
  const requirementText = (spec.requirements ?? [])
    .map((requirement) => `${requirement.id} ${requirement.statement ?? ''} ${requirement.title ?? ''}`)
    .join(' ');
  const CONFLICTS = [
    {
      idea: /(recover|restor|undo|grace|soft.?delete|30[ -]day)/i,
      requirement: /remove every field|in one operation|immediately and permanently/i,
      explain: 'the idea asks for a recoverable deletion but the selected deletion requirement erases in one operation',
      remedy: 'select the deletion-with-grace variant (the idea wording does this automatically), or record the erasure decision as a non-goal'
    },
    {
      idea: /(never (?:upload|store|send)[^.]{0,40}outside|stays? on[- ]device|local[- ]only)/i,
      requirement: /(upload|send|transmit)[^.]{0,40}(server|cloud|third[- ]party)/i,
      explain: 'the idea says data never leaves the device but a selected requirement transmits it',
      remedy: 'state which data crosses the boundary, or drop the requirement'
    }
  ];
  for (const conflict of CONFLICTS) {
    const ideaMatches = idea.match(conflict.idea);
    if (!ideaMatches) continue;
    const offending = (spec.requirements ?? []).filter((requirement) =>
      conflict.requirement.test(`${requirement.statement ?? ''} ${requirement.title ?? ''}`)
    );
    if (offending.length === 0) continue;
    const detail = `${offending.map((requirement) => requirement.id).join(', ')}: ${conflict.explain}`;
    if (strict) errors.push(`--strict: idea and requirement contradict (${detail}). ${conflict.remedy}.`);
    else warnings.push(`idea and requirement may contradict (${detail}). ${conflict.remedy}.`);
  }

  const byPattern = new Map();
  for (const requirement of requirements) {
    const ears = earsError(requirement.statement);
    if (ears) continue;
    const pattern = /^(Where|While|When|If)\b/.exec(requirement.statement)?.[1] ?? 'The';
    byPattern.set(pattern, (byPattern.get(pattern) ?? 0) + 1);
  }
  if (byPattern.size > 0) {
    passes.push(
      `${requirements.length} requirement statements parse as EARS (${[...byPattern.entries()].map(([shape, count]) => `${shape} ${count}`).join(', ')})`
    );
  }

  // 4b. overlay provenance
  const overlays = Array.isArray(spec.overlays) ? spec.overlays : [];
  if (overlays.length > 0) {
    const overlayIds = new Set(overlays.map((overlay) => overlay.id));
    const gateIds = new Set((spec.gates ?? []).map((gate) => gate.id));
    let claimed = 0;
    for (const overlay of overlays) {
      if (!['org', 'domain', 'team'].includes(overlay.layer)) {
        errors.push(`overlay "${overlay.id}" has layer "${overlay.layer}"; expected org, domain or team`);
      }
      for (const gate of overlay.adds?.gates ?? []) {
        claimed += 1;
        if (!gateIds.has(gate)) errors.push(`overlay "${overlay.id}" adds gate ${gate}, which is not in spec.json`);
      }
      for (const key of overlay.adds?.requirements ?? []) {
        claimed += 1;
        const requirement = requirements.find((entry) => entry.key === key);
        if (!requirement) errors.push(`overlay "${overlay.id}" adds requirement "${key}", which is not in spec.json`);
        else if (!String(requirement.origin ?? '').includes(overlay.id)) {
          errors.push(`${requirement.id} came from overlay "${overlay.id}" but does not say so in its origin`);
        }
      }
    }
    // The reverse direction: nothing may claim an overlay that is not listed.
    for (const requirement of requirements) {
      const origin = String(requirement.origin ?? 'catalog');
      if (origin === 'catalog' || origin === 'profile' || origin === 'change') continue;
      const ids = origin
        .replace(/^overlay:/, '')
        .split('+')
        .map((entry) => entry.replace('overlay:', ''))
        .filter((entry) => entry !== 'catalog' && entry !== 'profile' && entry !== 'change');
      for (const id of ids) {
        if (!overlayIds.has(id)) errors.push(`${requirement.id} claims overlay "${id}", which is not in spec.json`);
      }
    }
    passes.push(`${overlays.length} overlay(s) applied, ${claimed} requirement/gate claim(s) resolved`);
  }

  // 5. primitive references still resolve
  let index = null;
  try {
    index = loadIndex();
  } catch {
    warnings.push('primitives/index.json is missing; run `npm run index` to check quoted primitives');
  }

  if (index) {
    const byId = new Map(index.primitives.map((primitive) => [primitive.id, primitive]));
    for (const primitive of spec.primitives ?? []) {
      const actual = byId.get(primitive.id);
      if (!actual) {
        errors.push(`primitive "${primitive.id}" no longer exists in primitives/index.json`);
        continue;
      }
      if (actual.tier_min > tier) {
        errors.push(`primitive "${primitive.id}" requires tier ${actual.tier_min} but this packet is tier ${tier}`);
      }
      if (primitive.path && primitive.path !== actual.path) {
        warnings.push(`primitive "${primitive.id}" path moved: spec says ${primitive.path}, index says ${actual.path}`);
      }
    }
    if ((spec.primitives ?? []).length > 0) {
      passes.push(`${spec.primitives.length} quoted primitives resolve in the index`);
    }
  }

  // 6. anchors + executed test report (P2.1) + honest verdict hierarchy (P2.5)
  let parsedReport = testReport ?? null;
  if (!parsedReport && reportPath) {
    if (!existsSync(reportPath)) {
      errors.push(`test report not found: ${reportPath}`);
    } else {
      try {
        parsedReport = parseTestReport(readFileSync(reportPath, 'utf8'), { repoRoot: repo ?? '' });
      } catch (err) {
        errors.push(`invalid test report ${reportPath}: ${err.message}`);
      }
    }
  }
  if (requireReport && !parsedReport) {
    errors.push('--require-report set, but no test execution report was supplied (pass --run or --report <path>)');
  }

  let anchorStats = null;
  const requirementVerdicts = [];
  if (repo) {
    const { anchors, hollow, scanned, suppressed } = scanAnchors(repo, { exclude: spec.anchors?.exclude ?? [] });
    anchorStats = { scanned, anchored: anchors.size, suppressed };
    if (suppressed > 0) info.push(`${suppressed} anchor(s) ignored by @req-ignore or anchors.exclude`);
    // BLK-2 + P2.2: a hollow or tautological test that backs a requirement marked
    // *done* (or checked under --require-assertions / --run / --require-report) is an error.
    const doneIds = new Set(
      requirements
        .filter((requirement) => String(requirement.status ?? '').toLowerCase() === 'done')
        .map((requirement) => requirement.id)
    );
    const hollowReqIds = new Set();
    for (const entry of hollow) {
      const ids = entry.ids.filter((id) => known.has(id));
      if (ids.length === 0) continue;
      if (entry.kind !== 'no-import') {
        for (const id of ids) hollowReqIds.add(id);
      }
      const reason = entry.reason ?? 'no assertion in the anchored test';
      const message = `${entry.file} carries @req anchor(s) (${ids.join(', ')}) but ${reason}`;
      const claimed = entry.kind !== 'no-import' && ids.some((id) => doneIds.has(id));
      const enforceSemantics =
        entry.kind === 'misplaced-anchor' ||
        requireAssertions ||
        requireReport ||
        claimed;
      if (enforceSemantics) errors.push(message);
      else warnings.push(`${message} (pass --require-assertions to fail on hollow or tautological tests)`);
    }

    for (const [id, hits] of anchors) {
      if (!known.has(id)) {
        errors.push(`${hits[0].file} cites unknown requirement ${id}`);
      }
    }

    let pending = 0;
    let anchoredCount = 0;
    let staticAssertedCount = 0;
    let executedPassed = 0;
    let executedFailed = 0;
    let executedSkipped = 0;

    for (const requirement of requirements) {
      if (requirement.verify !== 'automated') {
        requirementVerdicts.push({
          id: requirement.id,
          verify: requirement.verify,
          status: requirement.verify === 'gate' ? 'gate-checked' : 'manual-unverified'
        });
        continue;
      }
      const hits = anchors.get(requirement.id) ?? [];
      const inTests = hits.filter((hit) => hit.isTest);
      const status = String(requirement.status ?? 'todo').toLowerCase();

      if (inTests.length > 0) {
        anchoredCount += 1;
        const hasValidAst = inTests.some((h) => h.astValid) && !hollowReqIds.has(requirement.id);
        if (hasValidAst) staticAssertedCount += 1;

        if (parsedReport) {
          const execOutcomes = inTests.map((h) => ({ hit: h, ...matchAnchorExecution(h, parsedReport) }));
          const anyFailed = execOutcomes.find((o) => o.status === 'failed');
          const anyPassed = execOutcomes.find((o) => o.status === 'passed');
          const anySkipped = execOutcomes.find((o) => o.status === 'skipped');

          if (anyFailed) {
            executedFailed += 1;
            const label = anyFailed.hit.testName ? ` "${anyFailed.hit.testName}"` : '';
            const why = status === 'done'
              ? 'is marked done, but no passing test'
              : 'has no passing test';
            errors.push(`${requirement.id} ${why}: anchored test${label} (${anyFailed.hit.file}:${anyFailed.hit.line}) executed and FAILED`);
            requirementVerdicts.push({ id: requirement.id, verify: 'automated', status: 'executed-failed', file: anyFailed.hit.file, testName: anyFailed.hit.testName });
          } else if (anySkipped && !anyPassed) {
            executedSkipped += 1;
            const label = anySkipped.hit.testName ? ` "${anySkipped.hit.testName}"` : '';
            errors.push(`${requirement.id} anchored test${label} (${anySkipped.hit.file}:${anySkipped.hit.line}) was SKIPPED (skipped/todo tests do not verify requirements)`);
            requirementVerdicts.push({ id: requirement.id, verify: 'automated', status: 'executed-skipped', file: anySkipped.hit.file, testName: anySkipped.hit.testName });
          } else if (anyPassed) {
            // Also fail if a sibling anchored test for the same requirement was skipped under strict/requireReport
            if (anySkipped && (strict || requireReport)) {
              const label = anySkipped.hit.testName ? ` "${anySkipped.hit.testName}"` : '';
              errors.push(`${requirement.id} has a skipped anchored test${label} (${anySkipped.hit.file}:${anySkipped.hit.line})`);
            }
            executedPassed += 1;
            const vStatus = mutationReport?.ok && hasValidAst ? 'mutation-verified' : 'executed-passed';
            requirementVerdicts.push({ id: requirement.id, verify: 'automated', status: vStatus, file: anyPassed.hit.file, testName: anyPassed.hit.testName });
          } else {
            const unrunMsg = `${requirement.id} is anchored in ${inTests[0].file}:${inTests[0].line} but did not run in the supplied test report`;
            if (requireReport) errors.push(unrunMsg);
            else warnings.push(unrunMsg);
            requirementVerdicts.push({
              id: requirement.id,
              verify: 'automated',
              status: hasValidAst ? 'static-asserted' : 'anchored-only',
              file: inTests[0].file,
              testName: inTests[0].testName
            });
          }
        } else {
          requirementVerdicts.push({
            id: requirement.id,
            verify: 'automated',
            status: hasValidAst ? 'static-asserted' : 'anchored-only',
            file: inTests[0].file,
            testName: inTests[0].testName
          });
        }
        continue;
      }

      requirementVerdicts.push({ id: requirement.id, verify: 'automated', status: 'unanchored' });
      if (hits.length > 0) {
        errors.push(`${requirement.id} is anchored only outside a test file (${hits.map((hit) => hit.file).join(', ')})`);
        continue;
      }
      if (status === 'done') {
        errors.push(`${requirement.id} is marked done but no test carries an @req anchor for it`);
      } else {
        pending += 1;
        const message = `${requirement.id} ${requirement.title}: no test anchor yet`;
        if (strict || requireReport) errors.push(message);
        else warnings.push(message);
      }
    }

    anchorStats = {
      ...anchorStats,
      automated: requirements.filter((r) => r.verify === 'automated').length,
      anchoredRequirements: anchoredCount,
      staticAsserted: staticAssertedCount,
      executedPassed,
      executedFailed,
      executedSkipped,
      pending
    };

    if (parsedReport) {
      info.push(
        `execution: ${executedPassed} executed-passed, ${executedFailed} failed, ${executedSkipped} skipped, ${pending} unanchored (${parsedReport.format}: ${parsedReport.passed}/${parsedReport.total} cases passed)`
      );
      if (executedPassed > 0 && executedFailed === 0 && executedSkipped === 0) {
        passes.push(`${executedPassed} automated requirement(s) executed-passed in test report`);
      }
    } else {
      info.push(
        `anchors (static — tests not executed): ${anchoredCount} anchored (${staticAssertedCount} AST-asserted), ${pending} pending, ${scanned} files scanned in ${repo}`
      );
      if (anchoredCount > 0) {
        passes.push(
          `${anchoredCount} automated requirement(s) proven by test anchors (${staticAssertedCount} static-asserted; run with --run or --report for execution proof)`
        );
      }
    }
  } else if (parsedReport) {
    warnings.push('test report was supplied without --repo <path>; anchor-to-test execution mapping skipped');
  }

  // P2.5: Derive exact, honest top-level verdict.
  const ok = errors.length === 0;
  let verdict = 'structurally-valid';
  if (!ok) {
    verdict = 'failed';
  } else if (repo && anchorStats) {
    const totalAuto = anchorStats.automated ?? 0;
    if (totalAuto === 0) {
      verdict = parsedReport?.ok ? 'executed-verified' : 'structurally-valid';
    } else if (parsedReport && anchorStats.executedPassed === totalAuto && anchorStats.staticAsserted === totalAuto) {
      verdict = mutationReport?.ok ? 'mutation-verified' : 'executed-verified';
    } else if (requireAssertions && anchorStats.staticAsserted === totalAuto) {
      verdict = 'static-asserted';
    } else {
      verdict = 'anchored-only';
    }
  }

  return {
    ok,
    verdict,
    errors,
    warnings,
    passes,
    info,
    requirementVerdicts,
    execution: parsedReport
      ? {
          format: parsedReport.format,
          total: parsedReport.total,
          passed: parsedReport.passed,
          failed: parsedReport.failed,
          skipped: parsedReport.skipped,
          ok: parsedReport.ok,
          sandboxBackend: parsedReport.sandboxBackend ?? null,
          receiptDigest: parsedReport.receiptDigest ?? null
        }
      : null,
    mutation: mutationReport
      ? {
          tool: mutationReport.tool,
          score: mutationReport.score,
          threshold: mutationReport.threshold,
          killed: mutationReport.killed,
          survived: mutationReport.survived,
          verdictLabel: mutationReport.verdictLabel
        }
      : null,
    stats: {
      packetType,
      tier,
      requirements: requirements.length,
      criteria,
      gates: gateIds.size,
      primitives: (spec.primitives ?? []).length,
      lines,
      ...anchorStats
    }
  };
}
