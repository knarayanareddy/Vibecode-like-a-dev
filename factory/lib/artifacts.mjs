/** Validated, human-authored delivery artifacts for optional VLD modules. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { requireVerifiedModules } from './modules.mjs';
import { readStoreAsset } from './stores.mjs';
import { ensureProjectDir, extensionError } from './extension-utils.mjs';

export const ARTIFACTS = {
  'product-brief': { module: 'product', title: 'Product Brief', file: 'docs/product-brief.md', sections: ['Problem', 'Users', 'Goals', 'Non-goals', 'Success Measures', 'Assumptions', 'Open Questions', 'Requirement Links'] },
  'architecture-decision': { module: 'architecture', title: 'Architecture Decision', file: (id) => `docs/adr/${id}.md`, sections: ['Context', 'Decision', 'Alternatives Considered', 'Consequences', 'Requirement Links'] },
  'delivery-plan': { module: 'delivery', title: 'Delivery Plan', file: 'docs/delivery-plan.md', sections: ['Scope', 'Increments', 'Dependencies', 'Rollback', 'Requirement Links'] },
  'review-brief': { module: 'review', title: 'Review Brief', file: 'docs/review-brief.md', sections: ['Change Summary', 'Requirements Under Review', 'Risk and Invariants', 'Evidence', 'Review Questions', 'Decision'] },
  'qa-plan': { module: 'qa', title: 'QA Plan', file: 'docs/qa-plan.md', sections: ['Risk-based Strategy', 'Requirement Coverage', 'End-to-End Scenarios', 'Release Evidence'] }
};
const ID = /^[a-z0-9][a-z0-9-]{1,60}$/;
const PLACEHOLDER = /\[(?:describe|state|list|add|name|link|record)[^\]]*\]|<[^>]+>|\b(?:TODO|TBD)\b|_confirm_/i;
const DRAFT = /\*\*Status:\*\*\s*(?:Draft|Proposed|Pending)/i;

export function listArtifacts() { return Object.entries(ARTIFACTS).map(([id, value]) => ({ id, ...value })); }
function typeOrThrow(kind) { if (!ARTIFACTS[kind]) throw extensionError(`unknown artifact "${kind}". Known: ${Object.keys(ARTIFACTS).join(', ')}`, 'UNKNOWN_ARTIFACT'); return ARTIFACTS[kind]; }
function fileFor(project, kind, id, explicit) {
  const type = typeOrThrow(kind);
  if (kind === 'architecture-decision' && !id) throw extensionError('architecture-decision needs a kebab-case decision id', 'ARTIFACT_ID_REQUIRED');
  if (id && !ID.test(id)) throw extensionError('artifact id must be lowercase kebab-case', 'INVALID_ARTIFACT_ID');
  return path.resolve(explicit ?? path.join(project, typeof type.file === 'function' ? type.file(id) : type.file));
}
function packetRequirements(packet) {
  const file = path.join(packet, 'spec.json');
  if (!existsSync(file)) return [];
  try { return JSON.parse(readFileSync(file, 'utf8')).requirements ?? []; } catch { return []; }
}
function headingBody(content, heading) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return '';
  const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();
}
function links(content) { return [...new Set(content.match(/REQ-\d{3}/g) ?? [])]; }
function storeReference(value) {
  const [storeId, assetId, ...extra] = String(value ?? '').split('/');
  if (!storeId || !assetId || extra.length) throw extensionError('store template must be written as <store-id>/<asset-id>', 'INVALID_STORE_TEMPLATE');
  return { storeId, assetId };
}
function template(kind, { profile = {}, requirements = [], id }) {
  const name = profile.name ?? 'project';
  const reqs = requirements.length ? requirements.map((r) => `- ${r.id} — ${r.title}`).join('\n') : '- [Link relevant REQ-### identifiers after compiling the packet.]';
  const common = `**Status:** Draft\n\n`;
  if (kind === 'product-brief') return `# Product Brief: ${name}\n\n${common}## Problem\n\n${profile.idea ?? '[Describe the user problem.]'}\n\n## Users\n\n- [Name the primary user and their current workaround.]\n\n## Goals\n\n- [State one measurable outcome.]\n\n## Non-goals\n\n- [State one explicit exclusion.]\n\n## Success Measures\n\n- [Add a measurable leading or outcome indicator.]\n\n## Assumptions\n\n- [Record an assumption that could change the plan.]\n\n## Open Questions\n\n- [Record an unresolved decision and its owner.]\n\n## Requirement Links\n\n${reqs}\n`;
  if (kind === 'architecture-decision') return `# ADR: ${id} — [Decision title]\n\n${common}## Context\n\n[Describe the constraints and forces.]\n\n## Decision\n\n[State the chosen approach and boundary.]\n\n## Alternatives Considered\n\n- [Alternative and why it was rejected.]\n\n## Consequences\n\n- [Positive or negative consequence.]\n\n## Requirement Links\n\n${reqs}\n`;
  if (kind === 'delivery-plan') return `# Delivery Plan: ${name}\n\n${common}## Scope\n\n[State the approved capability boundary.]\n\n## Increments\n\n### Increment 1 — [Name]\n\n- Goal: [State a user-visible outcome.]\n- Exit criteria: [State executable evidence.]\n\n## Dependencies\n\n- [Record a dependency or state none with evidence.]\n\n## Rollback\n\n[State the safe rollback or why none is required.]\n\n## Requirement Links\n\n${reqs}\n`;
  if (kind === 'review-brief') return `# Review Brief: ${name}\n\n${common}## Change Summary\n\n[Describe the changed behavior and blast radius.]\n\n## Requirements Under Review\n\n${reqs}\n\n## Risk and Invariants\n\n- [State the invariant a reviewer must protect.]\n\n## Evidence\n\n- [Record an executed command and its outcome.]\n\n## Review Questions\n\n- [Ask a falsifiable review question.]\n\n## Decision\n\n[Record approve, reject, or the blocking concern.]\n`;
  return `# QA Plan: ${name}\n\n${common}## Risk-based Strategy\n\n[Explain which failure paths need the strongest evidence.]\n\n## Requirement Coverage\n\n| Requirement | Test level | Evidence | Status |\n| --- | --- | --- | --- |\n${requirements.length ? requirements.filter((r) => r.verify === 'automated').map((r) => `| ${r.id} | [unit/integration/e2e] | [test path] | planned |`).join('\n') : '| REQ-### | [test level] | [test path] | planned |'}\n\n## End-to-End Scenarios\n\n### [Scenario name]\n\n- Given: [state]\n- When: [action]\n- Then: [observable result]\n\n## Release Evidence\n\n- [Record required test and gate evidence.]\n`;
}
export function initArtifact({ kind, projectDir='.', packetDir=null, profilePath=null, id=null, out=null, fromStore=null, force=false }) {
  const project=ensureProjectDir(projectDir), type=typeOrThrow(kind); requireVerifiedModules(project,[type.module]);
  const file=fileFor(project,kind,id,out); if (existsSync(file)&&!force) throw extensionError(`${file} exists; pass --force to replace it`, 'ARTIFACT_EXISTS');
  let profile={}; const p=path.resolve(profilePath ?? path.join(project,'profile.json')); if (existsSync(p)) try { profile=JSON.parse(readFileSync(p,'utf8')); } catch {}
  const requirements=packetRequirements(path.resolve(packetDir ?? path.join(project,'specs'))); let source=null;
  let content=template(kind,{profile,requirements,id});
  if (fromStore) {
    const reference=storeReference(fromStore); const imported=readStoreAsset({ projectDir: project, ...reference, kind: 'artifact-template' });
    if (imported.asset.artifact !== kind) throw extensionError(`store template "${fromStore}" is for ${imported.asset.artifact}, not ${kind}`, 'STORE_TEMPLATE_TYPE_MISMATCH');
    source={ store: imported.store.id, asset: imported.asset.id, commit: imported.store.commit, digest: imported.asset.digest };
    content=`${imported.content.trimEnd()}\n\n<!-- VLD template source: ${source.store}/${source.asset} @ ${source.commit} · sha256 ${source.digest} -->\n`;
  }
  mkdirSync(path.dirname(file),{recursive:true}); writeFileSync(file,content,'utf8'); return {project,kind,file,requirements:requirements.length,source};
}
export function validateArtifact({ kind, projectDir='.', packetDir=null, id=null, file=null, strict=false }) {
  const project=ensureProjectDir(projectDir), type=typeOrThrow(kind); requireVerifiedModules(project,[type.module]);
  const target=fileFor(project,kind,id,file), errors=[], warnings=[]; if(!existsSync(target)) return {ok:false,strictOk:false,file:target,errors:[`missing artifact: ${target}`],warnings,requirements:[]};
  const content=readFileSync(target,'utf8'); if(!content.startsWith(`# ${type.title === 'Architecture Decision' ? 'ADR:' : type.title}`)) errors.push('title does not match artifact type');
  for(const section of type.sections){ const body=headingBody(content,section); if(!body) errors.push(`missing or empty ## ${section}`); else if(body.length<20) warnings.push(`## ${section} is too thin`); }
  if(PLACEHOLDER.test(content)) warnings.push('contains an unfilled template placeholder'); if(DRAFT.test(content)) warnings.push('artifact status is still Draft, Proposed or Pending');
  const requirements=packetRequirements(path.resolve(packetDir ?? path.join(project,'specs'))), known=new Set(requirements.map(r=>r.id)), referenced=links(content);
  for(const req of referenced) if(!known.has(req)&&requirements.length) errors.push(`${req} is not in the packet`);
  if(requirements.length&&referenced.length===0) warnings.push('does not link to a packet requirement');
  if(kind==='qa-plan') { if(!requirements.length) errors.push('QA plan requires a compiled packet'); else { const missing=requirements.filter(r=>r.verify==='automated'&&!referenced.includes(r.id)).map(r=>r.id); if(missing.length) errors.push(`QA coverage is missing automated requirement(s): ${missing.join(', ')}`); } }
  const ok=errors.length===0; return {ok,strictOk:ok&&warnings.length===0,file:target,errors,warnings,requirements:referenced};
}
export function artifactStatus({ projectDir='.', packetDir=null }) {
  const project = ensureProjectDir(projectDir);
  return listArtifacts().map(({ id }) => {
    const decisionId = id === 'architecture-decision' ? 'feature-design' : null;
    const file = fileFor(project, id, decisionId, null);
    if (!existsSync(file)) return { id, file, exists: false };
    return { id, exists: true, ...validateArtifact({ kind: id, projectDir: project, packetDir, id: decisionId }) };
  });
}
