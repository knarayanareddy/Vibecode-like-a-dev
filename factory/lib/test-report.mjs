/**
 * Pure structured test-report parser & requirement-to-execution mapper (P2.1 & P2.5).
 *
 * Core compiler module (no subprocesses, no network). Ingests:
 *   - VLD normalized test-run JSON (`schemaVersion: 1`, `kind: 'vld-test-run'`)
 *   - Vitest / Jest JSON (`testResults: [{ name, assertionResults: [...] }]`)
 *   - Go `go test -json` NDJSON event streams (`Action: "pass"|"fail"|"skip"`, `Test`)
 *   - JUnit XML (`<testsuite>` / `<testcase>` with `<failure>`, `<error>`, `<skipped>`)
 *   - TAP v13 / v14 (including Node `node --test --test-reporter=tap` nested subtests
 *     with `location: '<file>:<line>:<col>'` YAML diagnostics)
 *
 * Maps every anchored test scope (`{ file, testName, startLine, endLine }`) to its
 * execution outcome (`passed`, `failed`, `skipped`, or `not-run`) so `vld verify`
 * and `spec-check.mjs` can distinguish:
 *   - `executed-passed`: anchored test ran AND passed
 *   - `executed-failed`: anchored test ran AND failed
 *   - `executed-skipped`: anchored test was skipped / todo / xfail / pending
 *   - `static-asserted` / `anchored-only`: anchored test was never observed running
 */

function normalizeRelFile(raw, repoRoot = '') {
  let s = String(raw ?? '').trim().replace(/^file:\/\//, '').replace(/\\/g, '/');
  if (repoRoot) {
    const normRoot = String(repoRoot).replace(/\\/g, '/').replace(/\/+$/, '');
    if (normRoot && s.startsWith(`${normRoot}/`)) {
      s = s.slice(normRoot.length + 1);
    }
  }
  return s.replace(/^\.\//, '');
}

function normalizeTestName(name) {
  return String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

function unescapeXml(str) {
  return String(str ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseXmlAttrs(attrSrc) {
  const attrs = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(attrSrc)) !== null) {
    attrs[m[1]] = unescapeXml(m[2] ?? m[3] ?? '');
  }
  return attrs;
}

/** Parse JUnit XML (`pytest --junitxml`, Maven Surefire, Gradle, PHPUnit, RSpec, cargo-nextest). */
export function parseJunitXml(xmlText, { repoRoot = '' } = {}) {
  const cases = [];
  const src = String(xmlText ?? '');
  // Match both self-closing `<testcase .../>` and paired `<testcase ...>...</testcase>`
  const tcRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gi;
  let m;
  while ((m = tcRe.exec(src)) !== null) {
    const attrs = parseXmlAttrs(m[1]);
    const inner = m[2] ?? '';
    let status = 'passed';
    let message = null;
    const failMatch = inner.match(/<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>/i) ?? inner.match(/<(failure|error)\b([^>]*)\/>/i);
    const skipMatch = inner.match(/<skipped\b([^>]*)(?:\/>|>([\s\S]*?)<\/skipped>)/i);
    if (failMatch) {
      status = 'failed';
      const fa = parseXmlAttrs(failMatch[2] ?? '');
      message = fa.message || unescapeXml((failMatch[3] ?? '').trim()).slice(0, 300) || 'test failed';
    } else if (skipMatch) {
      status = 'skipped';
      const sa = parseXmlAttrs(skipMatch[1] ?? '');
      message = sa.message || 'test skipped';
    }
    const rawFile = attrs.file || (attrs.classname ? `${attrs.classname.replace(/\./g, '/')}.py` : '');
    const durationMs = attrs.time ? Math.round(Number(attrs.time) * 1000) : 0;
    cases.push({
      name: normalizeTestName(attrs.name || ''),
      suite: attrs.classname || null,
      file: rawFile ? normalizeRelFile(rawFile, repoRoot) : null,
      line: attrs.line ? Number(attrs.line) : null,
      status,
      durationMs: Number.isFinite(durationMs) ? durationMs : 0,
      message
    });
  }
  return summarizeCases('junit-xml', cases);
}

/** Parse TAP v13 / v14 (including Node `node --test --test-reporter=tap`). */
export function parseTapReport(tapText, { repoRoot = '' } = {}) {
  const cases = [];
  const lines = String(tapText ?? '').split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(/^(\s*)(ok|not ok)\s+\d+\s*(?:-\s*)?(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const okWord = m[2];
    const rest = m[3].trim();

    // Check directive `# SKIP`, `# TODO`
    const dirMatch = rest.match(/^(.*?)\s+#\s*(SKIP|TODO|skip|todo)\b\s*(.*)$/);
    const rawName = normalizeTestName(dirMatch ? dirMatch[1] : rest);
    const directive = dirMatch ? dirMatch[2].toUpperCase() : null;
    const directiveReason = dirMatch ? dirMatch[3].trim() : null;

    // Parse optional indented YAML diagnostic block `--- ... ...`
    let file = null;
    let lineNo = null;
    let durationMs = 0;
    let diagType = null;
    let errorMsg = null;
    if (lines[i + 1] && lines[i + 1].trim() === '---' && lines[i + 1].search(/\S/) > indent) {
      let j = i + 2;
      while (j < lines.length && !(lines[j].trim() === '...' && lines[j].search(/\S/) > indent)) {
        const yl = lines[j].trim();
        const loc = yl.match(/^location:\s*['"]?(.+?):(\d+)(?::\d+)?['"]?$/);
        if (loc) {
          file = normalizeRelFile(loc[1], repoRoot);
          lineNo = Number(loc[2]);
        }
        const dur = yl.match(/^duration_ms:\s*([0-9.]+)/);
        if (dur) durationMs = Math.round(Number(dur[1]));
        const tp = yl.match(/^type:\s*['"]?(\w+)['"]?/);
        if (tp) diagType = tp[1];
        const err = yl.match(/^error:\s*['"]?(.+?)['"]?$/);
        if (err && err[1] !== '|-') errorMsg = err[1];
        j += 1;
      }
      i = j;
    }

    // Skip pure suite summary records when individual subtests were already recorded
    if (diagType === 'suite') continue;

    let status = okWord === 'ok' ? 'passed' : 'failed';
    if (directive === 'SKIP' || directive === 'TODO') {
      status = 'skipped';
    }
    // If Node reports a whole test file (`foo.test.mjs`) without `location:`, record `file` from name
    if (!file && /\.(?:test|spec)\.[mc]?[jt]sx?$/.test(rawName)) {
      file = normalizeRelFile(rawName, repoRoot);
    }

    cases.push({
      name: rawName,
      suite: null,
      file,
      line: lineNo,
      status,
      durationMs,
      message: status === 'skipped' ? (directiveReason || directive) : errorMsg
    });
  }
  return summarizeCases('tap', cases);
}

/** Parse Go `go test -json` NDJSON event streams. */
export function parseGoTestJson(ndjsonText) {
  const testMap = new Map();
  const outputMap = new Map();
  for (const rawLine of String(ndjsonText ?? '').split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(trimmed); } catch { continue; }
    if (!ev.Test || !ev.Action) continue;
    const key = `${ev.Package ?? ''}::${ev.Test}`;
    if (ev.Action === 'output' && typeof ev.Output === 'string') {
      const prev = outputMap.get(key) ?? '';
      if (prev.length < 1000) outputMap.set(key, prev + ev.Output);
    }
    if (ev.Action === 'pass' || ev.Action === 'fail' || ev.Action === 'skip') {
      const status = ev.Action === 'pass' ? 'passed' : ev.Action === 'fail' ? 'failed' : 'skipped';
      const out = outputMap.get(key) ?? '';
      const fileMatch = out.match(/\b([A-Za-z0-9_./-]+_test\.go):(\d+):/);
      testMap.set(key, {
        name: ev.Test,
        suite: ev.Package ?? null,
        file: fileMatch ? fileMatch[1] : null,
        line: fileMatch ? Number(fileMatch[2]) : null,
        status,
        durationMs: typeof ev.Elapsed === 'number' ? Math.round(ev.Elapsed * 1000) : 0,
        message: status === 'passed' ? null : out.trim().slice(-240) || `go test ${ev.Action}`
      });
    }
  }
  return summarizeCases('go-test-json', [...testMap.values()]);
}

/** Parse Vitest / Jest JSON (`{ testResults: [{ name, assertionResults }] }`). */
export function parseJestVitestJson(obj, { repoRoot = '' } = {}) {
  const cases = [];
  for (const suite of obj.testResults ?? []) {
    const file = suite.name ? normalizeRelFile(suite.name, repoRoot) : null;
    const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
    if (assertions.length === 0 && suite.status) {
      cases.push({
        name: file ?? 'suite',
        suite: null,
        file,
        line: null,
        status: suite.status === 'passed' ? 'passed' : suite.status === 'failed' ? 'failed' : 'skipped',
        durationMs: 0,
        message: suite.message ? String(suite.message).slice(0, 240) : null
      });
      continue;
    }
    for (const ar of assertions) {
      const rawStatus = String(ar.status ?? '').toLowerCase();
      let status = 'skipped';
      if (rawStatus === 'passed') status = 'passed';
      else if (rawStatus === 'failed') status = 'failed';
      else if (['skipped', 'pending', 'todo', 'disabled'].includes(rawStatus)) status = 'skipped';
      cases.push({
        name: normalizeTestName(ar.title || ar.fullName || ''),
        fullName: normalizeTestName(ar.fullName || ar.title || ''),
        suite: Array.isArray(ar.ancestorTitles) && ar.ancestorTitles.length ? ar.ancestorTitles.join(' > ') : null,
        file,
        line: ar.location?.line ? Number(ar.location.line) : null,
        status,
        durationMs: typeof ar.duration === 'number' ? Math.round(ar.duration) : 0,
        message: Array.isArray(ar.failureMessages) && ar.failureMessages.length ? String(ar.failureMessages[0]).slice(0, 240) : null
      });
    }
  }
  return summarizeCases('jest-vitest-json', cases);
}

function summarizeCases(format, cases) {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const c of cases) {
    if (c.status === 'passed') passed += 1;
    else if (c.status === 'failed') failed += 1;
    else skipped += 1;
  }
  return {
    schemaVersion: 1,
    kind: 'vld-test-run',
    format,
    total: cases.length,
    passed,
    failed,
    skipped,
    ok: cases.length > 0 && failed === 0,
    cases
  };
}

/**
 * Auto-detect and parse any supported structured test report string.
 */
export function parseTestReport(content, { format = 'auto', repoRoot = '' } = {}) {
  const text = String(content ?? '').trim();
  if (!text) {
    return summarizeCases('empty', []);
  }
  if (format === 'junit' || (format === 'auto' && text.startsWith('<') && /<test(?:suite|suites|case)\b/i.test(text))) {
    return parseJunitXml(text, { repoRoot });
  }
  if (format === 'tap' || (format === 'auto' && (/^TAP version \d+/m.test(text) || /^(?:ok|not ok)\s+\d+\b/m.test(text)))) {
    return parseTapReport(text, { repoRoot });
  }
  if (format === 'json' || format === 'auto') {
    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        if (parsed.kind === 'vld-test-run' && Array.isArray(parsed.cases)) {
          const normalized = parsed.cases.map((c) => ({
            ...c,
            file: c.file ? normalizeRelFile(c.file, repoRoot) : null
          }));
          return {
            ...summarizeCases(parsed.format ?? 'vld-test-run', normalized),
            command: parsed.command ?? null,
            sandboxBackend: parsed.sandboxBackend ?? null,
            receiptDigest: parsed.receiptDigest ?? null,
            generatedAt: parsed.generatedAt ?? null
          };
        }
        if (Array.isArray(parsed.testResults)) {
          return parseJestVitestJson(parsed, { repoRoot });
        }
      } catch {
        // Might be Go NDJSON (multiple `{...}` lines)
      }
      if (/^\{.*"Action"\s*:\s*"(?:run|pass|fail|skip)"/m.test(text)) {
        return parseGoTestJson(text);
      }
    }
  }
  if (format === 'go-json') {
    return parseGoTestJson(text);
  }
  throw new Error('Unsupported test report format; expected VLD JSON, Vitest/Jest JSON, Go `go test -json`, JUnit XML, or TAP v13/v14.');
}

function filesMatch(reportFile, anchorFile) {
  if (!reportFile || !anchorFile) return false;
  const a = reportFile.replace(/\\/g, '/').replace(/^\.\//, '');
  const b = anchorFile.replace(/\\/g, '/').replace(/^\.\//, '');
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function namesMatch(caseEntry, anchorTestName) {
  if (!anchorTestName || !caseEntry?.name) return false;
  const target = normalizeTestName(anchorTestName);
  const cand = normalizeTestName(caseEntry.name);
  const full = caseEntry.fullName ? normalizeTestName(caseEntry.fullName) : '';
  if (cand === target || full === target) return true;
  // Subtest suffix match: `Suite > test name` or `TestParent/sub` or `test_foo[param]`
  if (cand.endsWith(` > ${target}`) || full.endsWith(` > ${target}`)) return true;
  if (cand.startsWith(`${target}[`) || cand.startsWith(`${target}/`)) return true;
  if (cand.endsWith(`::${target}`) || cand.endsWith(`.${target}`)) return true;
  return false;
}

/**
 * Match a single anchored test location `{ file, testName, startLine, endLine }`
 * against parsed report cases.
 */
export function matchAnchorExecution(anchor, parsedReport) {
  const cases = parsedReport?.cases ?? [];
  if (cases.length === 0) return { status: 'not-run', matchedCases: [] };

  // 1. Exact file + line-range match (Node TAP & JUnit with line numbers)
  const byFileAndLine = cases.filter(
    (c) =>
      c.file &&
      filesMatch(c.file, anchor.file) &&
      Number.isFinite(c.line) &&
      Number.isFinite(anchor.startLine) &&
      c.line >= anchor.startLine - 1 &&
      c.line <= (anchor.endLine ?? anchor.startLine) + 1
  );
  if (byFileAndLine.length > 0) return aggregateMatchedCases(byFileAndLine);

  // 2. Exact file + test name match
  const byFileAndName = cases.filter(
    (c) => c.file && filesMatch(c.file, anchor.file) && namesMatch(c, anchor.testName)
  );
  if (byFileAndName.length > 0) return aggregateMatchedCases(byFileAndName);

  // 3. Test name match when runner omits file path (e.g. Go `go test -json` passing tests, plain TAP)
  if (anchor.testName) {
    const byNameOnly = cases.filter((c) => (!c.file || filesMatch(c.file, anchor.file)) && namesMatch(c, anchor.testName));
    if (byNameOnly.length > 0) return aggregateMatchedCases(byNameOnly);
  }

  // 4. Whole-file test entry (only when the report emitted file-level pass/fail with name === file)
  const byWholeFile = cases.filter((c) => c.file && filesMatch(c.file, anchor.file) && filesMatch(c.name, anchor.file));
  if (byWholeFile.length > 0) return aggregateMatchedCases(byWholeFile);

  return { status: 'not-run', matchedCases: [] };
}

function aggregateMatchedCases(matched) {
  // Precedence: any failure -> failed; any pass (with no failure) -> passed; all skipped -> skipped
  if (matched.some((c) => c.status === 'failed')) {
    return { status: 'failed', matchedCases: matched };
  }
  // If ANY matched parameterization was skipped and NONE passed, report skipped!
  if (matched.every((c) => c.status === 'skipped')) {
    return { status: 'skipped', matchedCases: matched };
  }
  return { status: 'passed', matchedCases: matched };
}
