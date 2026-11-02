/**
 * Human-authored, locally verified readiness evidence for an opted-in public web
 * discoverability contract. This deliberately has no crawler, browser, provider,
 * credential, ranking, indexing, traffic, or citation authority.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { digest, ensureProjectDir, extensionError, safeManagedDirectory, safeManagedFile, writeManagedFileAtomic } from './extension-utils.mjs';
import { loadProfile } from './profile.mjs';

export const DISCOVERABILITY_READINESS_FILE = 'docs/discoverability-readiness.md';
const REQUIRED_SECTIONS = [
  'Packet Authority',
  'Scope and Advisory Boundary',
  'Canonical Origin and Locale Policy',
  'Indexable Route Inventory',
  'Excluded Route Inventory',
  'Metadata and Social Contract',
  'Structured Data Evidence',
  'Local Verification Evidence',
  'Human Review Record',
  'Requirement Links'
];
const PLACEHOLDER = /\[(?:describe|state|list|add|name|link|record|enter|choose)[^\]]*\]|<[^>]+>|\b(?:TODO|TBD)\b|_confirm_/i;
const DRAFT = /\*\*Status:\*\*\s*(?:Draft|Proposed|Pending)/i;
const DIGEST = /^[a-f0-9]{64}$/;
const REQUIREMENT_ID = /^REQ-\d{3,}$/;

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function projectFile(project, supplied, fallback, label) {
  const candidate = path.resolve(project, supplied ?? fallback);
  if (!contained(project, candidate) || candidate === project) {
    throw extensionError(`${label} must remain inside the project directory`, 'INVALID_DISCOVERABILITY_PATH');
  }
  const relative = path.relative(project, candidate);
  return { file: candidate, relative: relative.split(path.sep).join('/') };
}

function requiredProfile(project, profilePath) {
  const { file, relative } = projectFile(project, profilePath, 'profile.json', 'discoverability profile');
  if (!existsSync(file)) throw extensionError(`discoverability profile does not exist: ${file}`, 'DISCOVERABILITY_PROFILE_NOT_FOUND');
  safeManagedFile(project, relative, 'discoverability profile');
  const loaded = loadProfile(file);
  if (loaded.errors.length) throw extensionError(`discoverability profile is invalid:\n${loaded.errors.map((error) => `- ${error}`).join('\n')}`, 'INVALID_DISCOVERABILITY_PROFILE');
  const { profile } = loaded;
  if (profile.kind !== 'web-app' || profile.risks?.publicFacing !== true || profile.discoverability?.enabled !== true) {
    throw extensionError('discoverability readiness requires kind "web-app", risks.publicFacing: true, and discoverability.enabled: true', 'DISCOVERABILITY_NOT_ENABLED');
  }
  return { profile, file, relative };
}

function packetAuthority(project, packetDir) {
  const { file: packet, relative: packetRelative } = projectFile(project, packetDir, 'specs', 'compiled packet directory');
  safeManagedDirectory(project, packetRelative, 'compiled packet directory');
  const specFile = path.join(packet, 'spec.json');
  const specRelative = path.relative(project, specFile);
  if (!existsSync(specFile)) throw extensionError(`compiled packet is missing spec.json: ${specFile}`, 'DISCOVERABILITY_PACKET_NOT_FOUND');
  safeManagedFile(project, specRelative, 'discoverability packet manifest');
  const source = readFileSync(specFile, 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (error) {
    throw extensionError(`compiled packet has invalid spec.json: ${error.message}`, 'INVALID_DISCOVERABILITY_PACKET');
  }
  const requirement = (manifest.requirements ?? []).find((entry) => entry?.key === 'web.discoverability' && REQUIREMENT_ID.test(String(entry.id ?? '')));
  if (!requirement) {
    throw extensionError('compiled packet does not contain the opted-in web.discoverability requirement', 'DISCOVERABILITY_REQUIREMENT_MISSING');
  }
  return {
    packet,
    packetRelative: packetRelative.split(path.sep).join('/'),
    specFile,
    specRelative: specRelative.split(path.sep).join('/'),
    digest: digest(source),
    requirement
  };
}

function headingBody(content, heading) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return '';
  const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();
}

function tableRows(body) {
  return body.split(/\r?\n/)
    .filter((line) => /^\|/.test(line.trim()))
    .filter((line) => !/^\|?\s*:?-{3,}/.test(line.trim()))
    .filter((line) => line.split('|').filter(Boolean).length > 1);
}

function packetMarker(body, name) {
  const expression = '^[ \\t]*[-*][ \\t]*' + name + ':[ \\t]*`?([^`\\n]+)`?[ \\t]*$';
  const match = new RegExp(expression, 'im').exec(body);
  return match?.[1]?.trim() ?? null;
}

function readinessTemplate({ profile, authority }) {
  return `# Discoverability Readiness: ${profile.name}\n\n**Status:** Draft\n\nThis is a human-authored, packet-linked local readiness record. It records locally controlled route and rendering evidence; it does not attest to ranking, traffic, third-party indexing, provider acceptance, or AI citation outcomes.\n\n## Packet Authority\n\n- Packet: \`${authority.specRelative}\`\n- Packet SHA-256: \`${authority.digest}\`\n- Discoverability requirement: \`${authority.requirement.id}\` — ${authority.requirement.title}\n\n## Scope and Advisory Boundary\n\n[Describe the approved public discovery surface and explicitly state that this record is local evidence, not a claim about provider outcomes.]\n\n## Canonical Origin and Locale Policy\n\n- Canonical origin: \`https://[public-origin.example]\`\n- Locale policy: [State default locale, alternate-locale, path, hostname, and trailing-slash policy.]\n\n## Indexable Route Inventory\n\n| Route class | Representative route | Canonical policy | Sitemap policy | Rendered metadata evidence |\n| --- | --- | --- | --- | --- |\n| [marketing or documentation] | [/path] | [one canonical URL] | [included/excluded] | [local test path or command] |\n\n## Excluded Route Inventory\n\n| Route class | Exclusion policy | Local evidence |\n| --- | --- | --- |\n| [account/admin/preview/search/error] | [noindex/absent/not listed] | [local test path or command] |\n\n## Metadata and Social Contract\n\n[Record how title, description, canonical URL, and social metadata are rendered and which representative-route checks cover them.]\n\n## Structured Data Evidence\n\n[Record each JSON-LD or structured-data type used, the rendered or maintained source that supports every asserted fact, and the local check that compares them.]\n\n## Local Verification Evidence\n\n- Command: \`[record the local route-level verification command]\`\n- Outcome: [Record the observed result and date.]\n\n## Human Review Record\n\n- Reviewer: [Name the accountable reviewer or review group.]\n- Reviewed on: [YYYY-MM-DD]\n- Decision: [Approved, conditional, or changes requested.]\n- Notes: [Record the decision rationale and unresolved risk, if any.]\n\n## Requirement Links\n\n- ${authority.requirement.id} — ${authority.requirement.title}\n`;
}

function validateHumanSections(content, errors, warnings) {
  for (const heading of REQUIRED_SECTIONS) {
    const body = headingBody(content, heading);
    if (!body) errors.push(`missing or empty ## ${heading}`);
    else if (body.length < 24) warnings.push(`## ${heading} is too thin`);
  }
  if (PLACEHOLDER.test(content)) warnings.push('contains an unfilled template placeholder');
  if (DRAFT.test(content)) warnings.push('artifact status is still Draft, Proposed or Pending');
}

function authoredField(body, label) {
  const value = new RegExp(`^[ \\t]*[-*]?[ \\t]*${label}[ \\t]*:[ \\t]*([^\\r\\n]+?)[ \\t]*$`, 'im').exec(body)?.[1]?.trim() ?? '';
  return value && !/[\[\]<>]/.test(value) && !/^(?:TODO|TBD)$/i.test(value) ? value : null;
}

function validateReadinessContent(content, authority, errors) {
  const packet = headingBody(content, 'Packet Authority');
  const declaredPacket = packetMarker(packet, 'Packet');
  if (declaredPacket !== authority.specRelative) errors.push(`## Packet Authority must record the current packet path ${authority.specRelative}`);
  const declaredDigest = packetMarker(packet, 'Packet SHA-256');
  if (!declaredDigest || !DIGEST.test(declaredDigest)) errors.push('## Packet Authority must record one 64-character Packet SHA-256');
  else if (declaredDigest !== authority.digest) errors.push('Packet SHA-256 does not match the current compiled packet; regenerate or re-review the artifact');
  const declaredRequirement = /^\s*[-*]\s*Discoverability requirement:\s*`?(REQ-\d{3,})`?/im.exec(packet)?.[1] ?? null;
  if (declaredRequirement !== authority.requirement.id) errors.push(`## Packet Authority must name ${authority.requirement.id} as the discoverability requirement`);

  const scope = headingBody(content, 'Scope and Advisory Boundary').toLowerCase();
  if (!/(local|locally)/.test(scope) || !/(not|never|no)\s+(?:a\s+)?(?:provider|third-party|external)/.test(scope)) {
    errors.push('## Scope and Advisory Boundary must state that this is local evidence, not external-provider authority');
  }
  if (!/(rank|traffic|index|citation)/.test(scope)) {
    errors.push('## Scope and Advisory Boundary must disclaim ranking, traffic, indexing, or citation outcomes');
  }

  const canonical = headingBody(content, 'Canonical Origin and Locale Policy');
  const origin = /https:\/\/[a-z0-9][a-z0-9.-]*(?::\d+)?(?:\/[^\s`)]*)?/i.exec(canonical)?.[0] ?? null;
  if (!origin || /https:\/\/(?:localhost|127\.0\.0\.1|\[::1\])/i.test(origin)) {
    errors.push('## Canonical Origin and Locale Policy must name one non-loopback https canonical origin');
  }
  if (!/locale|language|trailing|path|hostname/i.test(canonical)) {
    errors.push('## Canonical Origin and Locale Policy must state a locale or URL-policy decision');
  }

  for (const [heading, label] of [['Indexable Route Inventory', 'indexable'], ['Excluded Route Inventory', 'excluded']]) {
    const rows = tableRows(headingBody(content, heading));
    if (rows.length < 2) errors.push(`## ${heading} needs a header and at least one human-authored ${label} route row`);
  }

  const metadata = headingBody(content, 'Metadata and Social Contract').toLowerCase();
  for (const term of ['title', 'description', 'canonical']) if (!metadata.includes(term)) errors.push(`## Metadata and Social Contract must cover rendered ${term} behavior`);
  if (!/(social|open graph|og:)/.test(metadata)) errors.push('## Metadata and Social Contract must cover social metadata behavior');

  const structured = headingBody(content, 'Structured Data Evidence').toLowerCase();
  if (!/(json-ld|structured data)/.test(structured) || !/(rendered|source)/.test(structured) || !/(test|check|verify)/.test(structured)) {
    errors.push('## Structured Data Evidence must name structured data, its rendered/maintained support, and a local check');
  }

  const localEvidence = headingBody(content, 'Local Verification Evidence');
  if (!authoredField(localEvidence, 'Command') || !authoredField(localEvidence, 'Outcome')) {
    errors.push('## Local Verification Evidence must record non-placeholder local Command and Outcome values');
  }

  const review = headingBody(content, 'Human Review Record');
  for (const label of ['Reviewer', 'Reviewed on', 'Decision']) {
    if (!authoredField(review, label)) errors.push(`## Human Review Record must record a non-placeholder ${label} value`);
  }

  const links = headingBody(content, 'Requirement Links');
  const linked = new Set(links.match(/REQ-\d{3,}/g) ?? []);
  if (!linked.has(authority.requirement.id)) errors.push(`## Requirement Links must include ${authority.requirement.id}`);
}

/** Initialize a draft human readiness record from a verified, opted-in local packet. */
export function initDiscoverabilityReadiness({ projectDir = '.', profilePath = null, packetDir = null, out = null, force = false } = {}) {
  const project = ensureProjectDir(projectDir);
  const profile = requiredProfile(project, profilePath);
  const authority = packetAuthority(project, packetDir);
  const target = projectFile(project, out, DISCOVERABILITY_READINESS_FILE, 'discoverability readiness output');
  if (existsSync(target.file) && !force) throw extensionError(`${target.file} exists; pass --force to replace it`, 'DISCOVERABILITY_READINESS_EXISTS');
  writeManagedFileAtomic(project, target.relative, readinessTemplate({ profile: profile.profile, authority }), { overwrite: force, label: 'discoverability readiness output' });
  return {
    project,
    file: target.file,
    profile: profile.relative,
    packet: authority.specRelative,
    packetDigest: authority.digest,
    requirement: authority.requirement.id,
    advisory: true
  };
}

/** Validate only local structure, packet linkage, and stated review evidence. */
export function validateDiscoverabilityReadiness({ projectDir = '.', profilePath = null, packetDir = null, file = null, strict = false } = {}) {
  const project = ensureProjectDir(projectDir);
  const errors = [];
  const warnings = [];
  const profile = requiredProfile(project, profilePath);
  const authority = packetAuthority(project, packetDir);
  const target = projectFile(project, file, DISCOVERABILITY_READINESS_FILE, 'discoverability readiness artifact');
  if (!existsSync(target.file)) {
    return { ok: false, strictOk: false, advisory: true, project, file: target.file, errors: [`missing discoverability readiness artifact: ${target.file}`], warnings, packetDigest: authority.digest, requirement: authority.requirement.id };
  }
  safeManagedFile(project, target.relative, 'discoverability readiness artifact');
  const content = readFileSync(target.file, 'utf8');
  if (!content.startsWith(`# Discoverability Readiness: ${profile.profile.name}`)) errors.push('title does not match the opted-in project');
  validateHumanSections(content, errors, warnings);
  validateReadinessContent(content, authority, errors);
  const ok = errors.length === 0;
  return {
    ok,
    strictOk: ok && warnings.length === 0,
    advisory: true,
    project,
    file: target.file,
    profile: profile.relative,
    packet: authority.specRelative,
    packetDigest: authority.digest,
    requirement: authority.requirement.id,
    errors,
    warnings,
    passes: ok ? [`locally linked to ${authority.requirement.id} and ${authority.specRelative}`, 'records human review claims without asserting external-provider outcomes'] : []
  };
}
