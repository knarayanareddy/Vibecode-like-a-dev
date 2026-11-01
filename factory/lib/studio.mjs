/**
 * Dependency-free local Studio presentation assets.
 *
 * The dashboard is served by the Runtime process, contains no workspace data or
 * credentials, and keeps a manually supplied bearer token in JavaScript memory
 * only. It renders Runtime-provided strings with textContent, never HTML.
 */

import { randomBytes } from 'node:crypto';

export const STUDIO_PROTOCOL_VERSION = 1;
export const STUDIO_PATH = '/studio';

export function studioNonce() {
  return randomBytes(18).toString('base64');
}

export function studioContentSecurityPolicy(nonce) {
  return `default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'`;
}

/** A deliberately static shell. Runtime data arrives only through authenticated POST. */
export function studioHtml(nonce) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VLD Studio</title>
<style nonce="${nonce}">
:root { color-scheme: light dark; font: 16px/1.45 system-ui, sans-serif; }
body { max-width: 1120px; margin: 0 auto; padding: 1.25rem; }
h1 { margin: 0; } .muted { color: #667085; } .notice { border-left: .35rem solid #b54708; padding: .6rem .8rem; background: #fff7ed; color: #4a2400; }
.toolbar, .actions { display: flex; gap: .6rem; flex-wrap: wrap; align-items: end; margin: 1rem 0; } label { display: grid; gap: .2rem; font-weight: 600; }
input, button { font: inherit; padding: .45rem .55rem; } button { cursor: pointer; } button:disabled { cursor: not-allowed; opacity: .55; }
.grid { display: grid; gap: .9rem; grid-template-columns: repeat(auto-fit, minmax(270px, 1fr)); } section, .card { border: 1px solid #98a2b3; border-radius: .45rem; padding: .85rem; }
.card h3 { margin: 0 0 .35rem; } dl { display: grid; grid-template-columns: max-content 1fr; gap: .2rem .7rem; margin: .45rem 0; overflow-wrap: anywhere; } dt { font-weight: 700; }
ul { padding-left: 1.2rem; } .state { font-weight: 700; } .blocked { color: #b42318; font-weight: 700; } :focus-visible { outline: 3px solid #175cd3; outline-offset: 3px; }
</style>
</head>
<body>
<header><h1>VLD Studio</h1><p class="muted">Local Runtime dashboard. Runtime remains the authority; Studio stores no token or workspace state.</p></header>
<main>
<div id="connection" class="notice" role="status">Disconnected. Paste the local Runtime token printed by <code>vld runtime serve</code>, then connect.</div>
<div class="toolbar" aria-label="Runtime connection">
<label>Bearer token <input id="token" type="password" autocomplete="off" spellcheck="false" aria-describedby="token-help"></label>
<span id="token-help" class="muted">Used only in memory for this tab. It is never saved or displayed.</span>
<button id="connect" type="button">Connect and refresh</button><button id="refresh" type="button" disabled>Refresh status</button>
</div>
<section aria-labelledby="mission-heading"><h2 id="mission-heading">Mission</h2><div id="mission" class="muted">No Runtime status loaded.</div></section>
<section aria-labelledby="packages-heading"><h2 id="packages-heading">Mission board</h2><div id="packages" class="grid" aria-live="polite"></div></section>
<section aria-labelledby="runs-heading"><h2 id="runs-heading">Runs and verification</h2><div id="runs" class="grid"></div></section>
<section aria-labelledby="evidence-heading"><h2 id="evidence-heading">Evidence and review</h2><div id="evidence" class="grid"></div></section>
<section aria-labelledby="actions-heading"><h2 id="actions-heading">Typed Runtime actions</h2><p class="muted">Only the Runtime API can evaluate these requests. Candidate verification, approval and queue actions remain read-only here until their policy and identity inputs have a dedicated Runtime endpoint.</p>
<div class="actions"><label>Package <input id="package-id" autocomplete="off" spellcheck="false"></label><label>Assignee <input id="assignee" value="agent-alpha" autocomplete="off" spellcheck="false"></label><label>Lease ms <input id="lease-ms" inputmode="numeric" value="300000"></label><button id="allocate" type="button" disabled>Allocate package</button><button id="recover" type="button" disabled>Recover expired leases</button></div>
</section>
</main>
<script nonce="${nonce}">${studioDashboardScript()}</script>
</body></html>`;
}

/**
 * Browser program intentionally uses DOM nodes/textContent rather than template
 * interpolation for every Runtime field. Do not move Runtime strings into HTML.
 */
export function studioDashboardScript() {
  return `(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const elements = { token: $('token'), connect: $('connect'), refresh: $('refresh'), connection: $('connection'), mission: $('mission'), packages: $('packages'), runs: $('runs'), evidence: $('evidence'), packageId: $('package-id'), assignee: $('assignee'), leaseMs: $('lease-ms'), allocate: $('allocate'), recover: $('recover') };
  let token = '';
  let capabilities = { allocate: false, recover: false };
  function requestId() { return 'studio-' + (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2)); }
  function text(value) { if (value === null || value === undefined || value === '') return '—'; return Array.from(String(value), (character) => { const code = character.codePointAt(0); return code <= 31 || (code >= 127 && code <= 159) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) ? '�' : character; }).join(''); }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function element(tag, value, className) { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = text(value); return node; }
  function definition(parent, label, value) { parent.append(element('dt', label)); parent.append(element('dd', value)); }
  function card(title) { const node = element('article', undefined, 'card'); node.append(element('h3', title)); return node; }
  function setConnection(message, failed) { elements.connection.textContent = message; elements.connection.className = failed ? 'notice' : 'muted'; }
  function applyCapabilities(studio) { capabilities = studio && studio.actions ? studio.actions : { allocate: false, recover: false }; elements.allocate.disabled = !capabilities.allocate; elements.recover.disabled = !capabilities.recover; }
  async function call(method, params) {
    if (!token) throw new Error('A Runtime token is required.');
    const response = await fetch('/v1/runtime', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ schemaVersion: 1, requestId: requestId(), method, params }) });
    let body; try { body = await response.json(); } catch { throw new Error('Runtime returned an invalid response.'); }
    if (!response.ok || !body.ok) throw new Error((body && body.error && body.error.message) || 'Runtime request failed.');
    return body.result;
  }
  function renderMission(result) {
    clear(elements.mission); const runtime = result.runtime || {}; const mission = result.mission || {}; const list = document.createElement('dl');
    definition(list, 'Mission ID', runtime.missionId); definition(list, 'Packet digest', runtime.packetDigest); definition(list, 'Core policy digest', runtime.corePolicyDigest); definition(list, 'Mission current', mission.current ? 'yes' : 'no'); definition(list, 'Ledger sequence', runtime.sequence); definition(list, 'Identity', result.studio && result.studio.actor ? result.studio.actor.role + ':' + result.studio.actor.id : 'local Runtime'); elements.mission.append(list);
    for (const warning of result.warnings || []) elements.mission.append(element('p', warning, 'blocked'));
  }
  function renderPackages(result) {
    clear(elements.packages); for (const pkg of result.packages || []) { const node = card(pkg.id); const state = element('p', 'State: ' + text(pkg.state), 'state'); node.append(state); const list = document.createElement('dl'); definition(list, 'Dependencies', (pkg.dependsOn || []).join(', ')); definition(list, 'Requirements', (pkg.requirements || []).join(', ')); definition(list, 'Resource claims', (pkg.resourceClaims || []).join(', ')); definition(list, 'Run', pkg.run && pkg.run.id); definition(list, 'Lease health', pkg.lease ? 'active until ' + pkg.lease.expiresAt : 'none'); definition(list, 'Blocked cause', pkg.blocked); node.append(list); elements.packages.append(node); } if (!elements.packages.firstChild) elements.packages.append(element('p', 'No packages reported.', 'muted'));
  }
  function renderRuns(result) {
    clear(elements.runs); for (const run of result.agentRuns || []) { const node = card('Agent run · ' + run.packageId); const list = document.createElement('dl'); definition(list, 'Adapter', run.adapter); definition(list, 'Outcome', run.outcome); definition(list, 'Run ID', run.id); definition(list, 'Output digest', run.output && run.output.digest); definition(list, 'Summary', run.output && run.output.summary); node.append(list); elements.runs.append(node); } for (const item of result.delivery || []) { const receipt = item.candidate || item.verification || item.approval || item.queue; const type = item.candidate ? 'Candidate' : item.verification ? 'Verification' : item.approval ? 'Approval' : 'Queue'; const node = card(type + ' · ' + item.packageId); const list = document.createElement('dl'); definition(list, 'Receipt ID', receipt && receipt.id); definition(list, 'Candidate SHA', receipt && receipt.candidateSha); definition(list, 'Target SHA', receipt && receipt.targetSha); definition(list, 'Policy digest', receipt && receipt.policyDigest); definition(list, 'Outcome', receipt && receipt.outcome); node.append(list); elements.runs.append(node); } if (!elements.runs.firstChild) elements.runs.append(element('p', 'No bounded adapter or delivery receipts yet.', 'muted'));
  }
  function renderEvidence(result) { clear(elements.evidence); const node = card('Traceability'); const list = document.createElement('dl'); for (const pkg of result.packages || []) definition(list, pkg.id + ' requirements', (pkg.requirements || []).join(', ')); definition(list, 'Delivery receipts', (result.delivery || []).length); definition(list, 'Packet digest', result.runtime && result.runtime.packetDigest); node.append(list); elements.evidence.append(node); const catalog = result.studio && result.studio.catalog; if (catalog) { const catalogCard = card('Signed content catalog'); const catalogList = document.createElement('dl'); definition(catalogList, 'Trust state', catalog.ok ? 'verified' : 'degraded'); definition(catalogList, 'Root digest', catalog.trustedRoot && catalog.trustedRoot.digest); for (const item of catalog.catalogs || []) { definition(catalogList, item.id + ' publisher(s)', (item.packages || []).map((pkg) => pkg.publisher && pkg.publisher.id).join(', ')); definition(catalogList, item.id + ' content digest', item.indexDigest); } catalogCard.append(catalogList); for (const error of catalog.errors || []) catalogCard.append(element('p', error, 'blocked')); elements.evidence.append(catalogCard); } }
  function render(result) { applyCapabilities(result.studio); renderMission(result); renderPackages(result); renderRuns(result); renderEvidence(result); setConnection(result.ok === false ? 'Connected, but Runtime reports a degraded/read-only state. Read the warnings above.' : 'Connected to local Runtime. Status is authoritative.', result.ok === false); }
  async function refresh() { try { render(await call('status', {})); } catch (error) { applyCapabilities(null); setConnection(error.message, true); } }
  elements.connect.addEventListener('click', async () => { token = elements.token.value; elements.token.value = ''; await refresh(); if (token) elements.refresh.disabled = false; });
  elements.refresh.addEventListener('click', refresh);
  elements.allocate.addEventListener('click', async () => { try { if (!globalThis.crypto || !crypto.randomUUID) throw new Error('This browser cannot generate a lease capability. Use the CLI instead.'); const leaseMs = Number(elements.leaseMs.value); const leaseToken = 'lease-' + crypto.randomUUID(); const result = await call('allocate', { packageId: elements.packageId.value, assignee: { role: 'implementer', id: elements.assignee.value }, leaseMs, leaseToken }); await refresh(); setConnection('Allocation created. Copy this lease capability now; Studio will not retain it: ' + result.leaseToken, false); } catch (error) { setConnection(error.message, true); } });
  elements.recover.addEventListener('click', async () => { try { await call('recover', {}); await refresh(); } catch (error) { setConnection(error.message, true); } });
})();`;
}

/** Runtime API status decoration: a UI hint, never an authorization decision. */
export function studioCapabilities(actor) {
  return {
    allocate: ['operator', 'runtime'].includes(actor?.role),
    recover: ['operator', 'runtime'].includes(actor?.role),
    transition: ['implementer', 'reviewer', 'release-approver', 'operator', 'runtime', 'forge'].includes(actor?.role)
  };
}
