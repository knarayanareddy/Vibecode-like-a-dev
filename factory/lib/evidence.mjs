/**
 * Append-only SHA-256 hash-chained evidence ledger and strictly opt-in,
 * zero-PII local telemetry (ADR 0012, roadmap 3.4).
 *
 * Ledger format (`.vld/evidence/evidence.jsonl`):
 *   One canonical JSON object per line:
 *     { schemaVersion: 1, seq, at, kind, actor, subject, payload, prevHash, hash }
 *   Genesis (`seq === 1`) binds `prevHash = "0".repeat(64)`. Each subsequent
 *   entry binds `prevHash = previous.hash`, and `hash = digest(entryWithoutHash)`.
 *   Modifying, deleting, inserting or reordering any line invalidates the chain.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { digest, ensureProjectDir, extensionError, ID_PATTERN, stableJson } from './extension-utils.mjs';

const canonicalJson = (value) => `${stableJson(value)}\n`;

export const EVIDENCE_SCHEMA_VERSION = 1;
export const GENESIS_HASH = '0'.repeat(64);
export const EVIDENCE_KINDS = Object.freeze([
  'compile',
  'verify',
  'sandbox-run',
  'agent-transcript',
  'repair',
  'review',
  'approval',
  'queue',
  'forge',
  'drift',
  'build',
  'migration',
  'intake',
  'intake-accepted',
  'profile-answer',
  'agent-transcript',
  'broker-session',
  'budget-halt',
  'operator-control',
  'attestation'
]);

const DEFAULT_LEDGER_REL = path.join('.vld', 'evidence', 'evidence.jsonl');
const TELEMETRY_CONFIG_REL = path.join('.vld', 'telemetry', 'config.json');
const TELEMETRY_EVENTS_REL = path.join('.vld', 'telemetry', 'events.jsonl');
const SHA256_HEX = /^[a-f0-9]{64}$/;
const SECRET_RE = /(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~+/-]{8,}|(?:api[_-]?key|token|secret|password|credential|authorization)\s*(?:=|:)\s*[^\s,"']+)/gi;

function scrubValue(value, depth = 0) {
  if (depth > 6) return '[TRUNCATED]';
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    return value.replace(SECRET_RE, '[REDACTED]').replace(/\0/g, '').slice(0, 1000);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 128).map((item) => scrubValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort().slice(0, 64)) {
      if (/^(?:token|secret|password|credential|authorization|apiKey|leaseToken)$/i.test(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = scrubValue(value[key], depth + 1);
      }
    }
    return out;
  }
  return String(value).slice(0, 200);
}

function safeProjectFile(projectDir, relPath) {
  const project = ensureProjectDir(projectDir);
  if (typeof relPath !== 'string' || !relPath.trim() || path.isAbsolute(relPath) || relPath.includes('..') || /[\r\n\0]/.test(relPath)) {
    throw extensionError('evidence path must be a safe relative path inside the project', 'INVALID_EVIDENCE_PATH');
  }
  const full = path.resolve(project, relPath);
  let cursor = project;
  for (const segment of path.relative(project, full).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw extensionError('evidence path may not traverse a symbolic link', 'INVALID_EVIDENCE_PATH');
    }
  }
  return { project, file: full };
}

function entryHash(entry) {
  const { hash: _ignored, ...body } = entry;
  return digest(body);
}

function parseLedgerLines(file) {
  if (!existsSync(file)) return { lines: [], entries: [], parseErrors: [] };
  const raw = readFileSync(file, 'utf8');
  if (!raw.trim()) return { lines: [], entries: [], parseErrors: [] };
  const lines = raw.split('\n').filter((line) => line.length > 0);
  const entries = [];
  const parseErrors = [];
  lines.forEach((line, index) => {
    try {
      entries.push({ lineNumber: index + 1, record: JSON.parse(line) });
    } catch (error) {
      parseErrors.push({ lineNumber: index + 1, error: `invalid JSON on line ${index + 1}: ${error.message}` });
    }
  });
  return { lines, entries, parseErrors };
}

/**
 * Verify the entire hash-chained `evidence.jsonl` ledger from genesis to head.
 */
export function verifyEvidenceChain({ projectDir = '.', file = DEFAULT_LEDGER_REL } = {}) {
  const resolved = safeProjectFile(projectDir, file);
  if (!existsSync(resolved.file)) {
    return {
      ok: true,
      exists: false,
      file: resolved.file,
      entries: 0,
      headHash: GENESIS_HASH,
      firstBrokenSeq: null,
      errors: [],
      records: []
    };
  }
  const { entries, parseErrors } = parseLedgerLines(resolved.file);
  const errors = parseErrors.map((e) => e.error);
  let firstBrokenSeq = parseErrors.length > 0 ? parseErrors[0].lineNumber : null;
  let expectedPrev = GENESIS_HASH;
  let expectedSeq = 1;
  const records = [];

  for (const { lineNumber, record } of entries) {
    const failAt = (msg) => {
      errors.push(`seq ${expectedSeq} (line ${lineNumber}): ${msg}`);
      if (firstBrokenSeq === null) firstBrokenSeq = expectedSeq;
    };
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      failAt('record must be a JSON object');
      expectedSeq += 1;
      continue;
    }
    if (record.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
      failAt(`schemaVersion must be ${EVIDENCE_SCHEMA_VERSION}`);
    }
    if (record.seq !== expectedSeq) {
      failAt(`expected sequence ${expectedSeq}, found ${record.seq}`);
    }
    if (!EVIDENCE_KINDS.includes(record.kind)) {
      failAt(`unknown evidence kind "${record.kind}"`);
    }
    if (typeof record.at !== 'string' || Number.isNaN(new Date(record.at).getTime())) {
      failAt('invalid ISO-8601 timestamp');
    }
    if (record.prevHash !== expectedPrev) {
      failAt(`prevHash mismatch (chain break: expected ${expectedPrev.slice(0, 12)}…, got ${String(record.prevHash ?? '').slice(0, 12)}…)`);
    }
    if (!SHA256_HEX.test(String(record.hash ?? ''))) {
      failAt('hash is not a 64-character sha256 hex digest');
    } else {
      const computed = entryHash(record);
      if (computed !== record.hash) {
        failAt(`content hash mismatch (tampered record: expected ${computed.slice(0, 12)}…, stored ${record.hash.slice(0, 12)}…)`);
      }
      expectedPrev = record.hash;
    }
    records.push(record);
    expectedSeq += 1;
  }

  return {
    ok: errors.length === 0,
    exists: true,
    file: resolved.file,
    entries: records.length,
    headHash: expectedPrev,
    firstBrokenSeq,
    errors,
    records
  };
}

/**
 * Append a secret-scrubbed, hash-chained entry to `.vld/evidence/evidence.jsonl`.
 * Refuses to append onto a broken chain so tampering can never be buried.
 */
export function appendEvidence({
  projectDir = '.',
  file = DEFAULT_LEDGER_REL,
  kind,
  actor = 'system:vld',
  subject = 'project',
  payload = {},
  at = new Date().toISOString()
} = {}) {
  if (!EVIDENCE_KINDS.includes(kind)) {
    throw extensionError(`evidence kind must be one of: ${EVIDENCE_KINDS.join(', ')}`, 'INVALID_EVIDENCE_KIND');
  }
  if (typeof at !== 'string' || Number.isNaN(new Date(at).getTime())) {
    throw extensionError('evidence timestamp must be a valid ISO-8601 string', 'INVALID_EVIDENCE_TIME');
  }
  const chain = verifyEvidenceChain({ projectDir, file });
  if (!chain.ok) {
    throw extensionError(
      `refusing to append to tampered evidence chain (broken at seq ${chain.firstBrokenSeq}): ${chain.errors[0]}`,
      'EVIDENCE_CHAIN_BROKEN'
    );
  }
  const actorStr = typeof actor === 'string'
    ? actor.replace(/[\r\n\0]/g, '').slice(0, 120)
    : `${actor?.role ?? 'actor'}:${actor?.id ?? 'unknown'}`;
  const body = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    seq: chain.entries + 1,
    at,
    kind,
    actor: scrubValue(actorStr),
    subject: scrubValue(String(subject ?? 'project').slice(0, 200)),
    payload: scrubValue(payload ?? {}),
    prevHash: chain.headHash
  };
  const record = { ...body, hash: digest(body) };
  mkdirSync(path.dirname(chain.file), { recursive: true });
  const serialized = `${JSON.stringify(record)}\n`;
  const existing = existsSync(chain.file) ? readFileSync(chain.file, 'utf8') : '';
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? `${existing}\n` : existing;
  writeFileSync(chain.file, `${prefix}${serialized}`, 'utf8');
  return { ok: true, file: chain.file, entry: record, headHash: record.hash, entries: record.seq };
}

/** Bounded projection safe for Studio / Runtime API status responses. */
export function studioEvidenceProjection({ projectDir = '.', file = DEFAULT_LEDGER_REL, limit = 10 } = {}) {
  const verified = verifyEvidenceChain({ projectDir, file });
  const countsByKind = {};
  for (const rec of verified.records) {
    countsByKind[rec.kind] = (countsByKind[rec.kind] ?? 0) + 1;
  }
  return {
    exists: verified.exists,
    ok: verified.ok,
    entries: verified.entries,
    headHash: verified.headHash,
    firstBrokenSeq: verified.firstBrokenSeq,
    countsByKind,
    recent: verified.records.slice(-Math.max(1, Math.min(limit, 25))).map((rec) => ({
      seq: rec.seq,
      at: rec.at,
      kind: rec.kind,
      actor: rec.actor,
      subject: rec.subject,
      hash: rec.hash
    })),
    errors: verified.errors.slice(0, 5)
  };
}

/** Export a self-contained compliance evidence report (`json` or `markdown`). */
export function exportEvidenceBundle({ projectDir = '.', file = DEFAULT_LEDGER_REL, format = 'json' } = {}) {
  const verified = verifyEvidenceChain({ projectDir, file });
  const countsByKind = {};
  for (const rec of verified.records) countsByKind[rec.kind] = (countsByKind[rec.kind] ?? 0) + 1;
  const bundleBody = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    chainValid: verified.ok,
    entries: verified.entries,
    genesisHash: GENESIS_HASH,
    headHash: verified.headHash,
    firstBrokenSeq: verified.firstBrokenSeq,
    countsByKind,
    errors: verified.errors,
    records: verified.records
  };
  const bundle = { ...bundleBody, bundleDigest: digest(bundleBody) };
  if (format === 'markdown') {
    const lines = [
      '# VLD Audit Evidence Bundle',
      '',
      `- **Chain integrity:** ${bundle.chainValid ? 'VERIFIED' : `BROKEN at seq ${bundle.firstBrokenSeq}`}`,
      `- **Total entries:** ${bundle.entries}`,
      `- **Head SHA-256:** \`${bundle.headHash}\``,
      `- **Bundle SHA-256:** \`${bundle.bundleDigest}\``,
      `- **Exported at:** ${bundle.exportedAt}`,
      '',
      '## Entries',
      '',
      '| Seq | Timestamp | Kind | Actor | Subject | Hash |',
      '| --- | --- | --- | --- | --- | --- |'
    ];
    for (const rec of bundle.records) {
      lines.push(`| ${rec.seq} | ${rec.at} | ${rec.kind} | ${rec.actor} | ${rec.subject} | \`${rec.hash.slice(0, 12)}\` |`);
    }
    return `${lines.join('\n')}\n`;
  }
  return `${canonicalJson(bundle)}`;
}

// ---------------------------------------------------------------------------
// Strictly opt-in, local-only, zero-PII telemetry (roadmap 3.4)
// ---------------------------------------------------------------------------

const ALLOWED_TELEMETRY_EVENTS = new Set(['plan', 'compile', 'verify', 'adopt', 'build', 'repair', 'drift', 'review']);

/** Read telemetry configuration. Always defaults to `{ enabled: false }`. */
export function telemetryStatus({ projectDir = '.' } = {}) {
  const cfg = safeProjectFile(projectDir, TELEMETRY_CONFIG_REL);
  const ev = safeProjectFile(projectDir, TELEMETRY_EVENTS_REL);
  let config = { schemaVersion: 1, enabled: false, updatedAt: null };
  if (existsSync(cfg.file)) {
    try {
      const parsed = JSON.parse(readFileSync(cfg.file, 'utf8'));
      config = { schemaVersion: 1, enabled: parsed?.enabled === true, updatedAt: parsed?.updatedAt ?? null };
    } catch {}
  }
  const lines = existsSync(ev.file) ? readFileSync(ev.file, 'utf8').split('\n').filter(Boolean) : [];
  const counts = {};
  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      if (item?.event) counts[item.event] = (counts[item.event] ?? 0) + 1;
    } catch {}
  }
  return {
    enabled: config.enabled,
    networkTransmission: 'never-automatic (local export only)',
    updatedAt: config.updatedAt,
    recordedEvents: lines.length,
    counts
  };
}

/** Enable or disable opt-in local telemetry. */
export function configureTelemetry({ projectDir = '.', enabled } = {}) {
  if (typeof enabled !== 'boolean') throw extensionError('telemetry enabled must be boolean', 'INVALID_TELEMETRY_CONFIG');
  const cfg = safeProjectFile(projectDir, TELEMETRY_CONFIG_REL);
  mkdirSync(path.dirname(cfg.file), { recursive: true });
  const data = { schemaVersion: 1, enabled, updatedAt: new Date().toISOString() };
  writeFileSync(cfg.file, canonicalJson(data), 'utf8');
  return telemetryStatus({ projectDir });
}

/** Purge all locally recorded telemetry events immediately. */
export function purgeTelemetry({ projectDir = '.' } = {}) {
  const ev = safeProjectFile(projectDir, TELEMETRY_EVENTS_REL);
  if (existsSync(ev.file)) rmSync(ev.file, { force: true });
  return telemetryStatus({ projectDir });
}

/**
 * Record one anonymous metric ONLY when the user explicitly opted in.
 * Allowlists solely enum/boolean/integer fields — never stores names, prose,
 * paths, identifiers, tokens or IP addresses.
 */
export function recordTelemetryEvent({ projectDir = '.', event, ok = true, tier = null, durationMs = 0, count = null } = {}) {
  if (!ALLOWED_TELEMETRY_EVENTS.has(event)) return { recorded: false, reason: 'unknown-event' };
  const status = telemetryStatus({ projectDir });
  if (!status.enabled) return { recorded: false, reason: 'disabled' };
  const ev = safeProjectFile(projectDir, TELEMETRY_EVENTS_REL);
  mkdirSync(path.dirname(ev.file), { recursive: true });
  const entry = {
    schemaVersion: 1,
    day: new Date().toISOString().slice(0, 10),
    event,
    ok: Boolean(ok),
    ...(Number.isInteger(tier) && tier >= 0 && tier <= 3 ? { tier } : {}),
    durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : 0,
    ...(Number.isInteger(count) && count >= 0 ? { count } : {}),
    ...(ID_PATTERN.test(event) ? {} : {})
  };
  const existing = existsSync(ev.file) ? readFileSync(ev.file, 'utf8') : '';
  writeFileSync(ev.file, `${existing}${JSON.stringify(entry)}\n`, 'utf8');
  return { recorded: true, entry };
}
