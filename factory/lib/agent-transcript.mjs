/**
 * Agent tool-call transcripts (ADR 0011, roadmap 3.3).
 *
 * Every tool call an autonomous implementer makes is appended to a JSONL
 * transcript inside its sandboxed workspace. Each line carries content
 * digests (never raw secrets) plus an `entryDigest`; a final `transcriptDigest`
 * covers every entry digest in order. The digest is copied into the Runtime
 * agent-run receipt, the delivery candidate, and `.vld/evidence/evidence.jsonl`
 * so the exact tool sequence behind a change is verifiable after the fact.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

/** Canonical form of a transcript entry (excludes `entryDigest` itself). */
export function canonicalTranscriptEntry(entry) {
  return JSON.stringify({
    seq: Number(entry.seq),
    at: String(entry.at ?? ''),
    type: String(entry.type ?? 'tool'),
    tool: String(entry.tool ?? ''),
    argsDigest: String(entry.argsDigest ?? ''),
    resultDigest: String(entry.resultDigest ?? ''),
    ok: entry.ok !== false,
    ...(entry.durationMs !== undefined ? { durationMs: Number(entry.durationMs) } : {})
  });
}

export function transcriptEntryDigest(entry) {
  return digest(canonicalTranscriptEntry(entry));
}

/** Digest over the ordered entry digests — the value recorded in evidence. */
export function computeTranscriptDigest(entries) {
  const hash = createHash('sha256');
  for (const entry of entries) hash.update(`${transcriptEntryDigest(entry)}\n`);
  return hash.digest('hex');
}

/**
 * Verify a transcript (JSONL text or parsed lines) end to end:
 * every entry digest recomputes and the summary's transcriptDigest matches.
 */
export function verifyAgentTranscript(source, { expectedDigest = null } = {}) {
  const text = Array.isArray(source) ? source.join('\n') : String(source ?? '');
  const errors = [];
  const entries = [];
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  for (let i = 0; i < lines.length; i += 1) {
    let parsed;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      errors.push(`line ${i + 1}: not valid JSON`);
      continue;
    }
    if (parsed.type === 'summary') {
      if (parsed.transcriptDigest !== computeTranscriptDigest(entries)) {
        errors.push(`line ${i + 1}: summary transcriptDigest does not match entries`);
      }
      if (expectedDigest !== null && parsed.transcriptDigest !== expectedDigest) {
        errors.push(`line ${i + 1}: summary transcriptDigest does not match expected digest`);
      }
      continue;
    }
    if (parsed.entryDigest !== transcriptEntryDigest(parsed)) {
      errors.push(`line ${i + 1}: entryDigest mismatch (transcript tampered)`);
    }
    entries.push(parsed);
  }
  if (!entries.length) errors.push('transcript contains no tool entries');
  const digestValue = computeTranscriptDigest(entries);
  if (expectedDigest !== null && !lines.some((line) => line.includes('"summary"')) && digestValue !== expectedDigest) {
    errors.push('transcript digest does not match expected digest');
  }
  return { ok: errors.length === 0, errors, entries, digest: digestValue };
}

/** Convenience: verify a transcript file from disk. */
export function verifyAgentTranscriptFile(file, options = {}) {
  return verifyAgentTranscript(readFileSync(file, 'utf8'), options);
}

/**
 * Move an agent's transcript artifacts out of its workspace into the project's
 * `.vld/agent-transcripts/` store. The workspace must stay deliverable-clean
 * (resource-claim gates and candidate submission treat stray files as scope
 * violations), while the transcript itself is preserved as durable evidence.
 */
export function harvestTranscripts({ from, to, runId }) {
  const moved = [];
  for (const suffix of ['.jsonl', '.summary.json']) {
    const src = path.join(from, `${runId}${suffix}`);
    if (!existsSync(src)) continue;
    mkdirSync(to, { recursive: true });
    const dest = path.join(to, `${runId}${suffix}`);
    try {
      renameSync(src, dest);
    } catch {
      copyFileSync(src, dest);
      unlinkSync(src);
    }
    moved.push(dest);
  }
  return moved;
}
