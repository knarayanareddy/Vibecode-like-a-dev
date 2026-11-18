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
<header><h1>VLD Studio</h1><p class="muted">Local Runtime dashboard. Runtime remains the authority; Studio stores no token or workspace state. Keyboard: <code>r</code> refresh · <code>c</code> candidate · <code>a</code> approve · <code>q</code> queue · <code>p</code> pause · <code>k</code> kill · <code>?</code> help.</p></header>
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
<section aria-labelledby="candidate-heading"><h2 id="candidate-heading">Candidate review</h2>
<p class="muted">Requirement coverage matrix, mutation score, sandbox receipt, findings, diff and cost for one frozen candidate. Keyboard: <code>c</code> loads, <code>a</code> approves, <code>q</code> queues.</p>
<div class="actions"><label>Package <input id="candidate-package" autocomplete="off" spellcheck="false"></label><label>Candidate ID <input id="candidate-target" placeholder="latest" autocomplete="off" spellcheck="false"></label><button id="load-candidate" type="button">Load candidate</button><span id="evidence-badge" class="state" role="status"></span></div>
<div id="candidate-page" class="grid" aria-live="polite"></div>
</section>
<section aria-labelledby="live-heading"><h2 id="live-heading">Live agent steps</h2>
<p class="muted">Server-sent run events from the Runtime ledger. Keyboard: <code>p</code> pauses at the next attempt boundary, <code>k</code> kills immediately; both are recorded in the ledger.</p>
<div class="actions"><label>Package <input id="stop-package" autocomplete="off" spellcheck="false"></label><label>Run ID <input id="run-id" autocomplete="off" spellcheck="false"></label><label>Reason <input id="stop-reason" value="Reviewed from Studio" autocomplete="off" spellcheck="false"></label><button id="watch-run" type="button">Watch events</button><button id="pause-run" type="button" disabled>Pause run</button><button id="kill-run" type="button" disabled>Kill run</button></div>
<div id="live-steps" role="log" aria-live="polite"></div>
</section>
<section aria-labelledby="questions-heading"><h2 id="questions-heading">Profile questions (assisted intake)</h2><p class="muted">Answers are recorded by the Runtime with <code>provenance: user</code>; one answer can unlock dependent questions. Waiving a risk flag or regulation needs a reason and an expiry date.</p>
<div class="actions"><label>Profile file <input id="profile-file" value="profile.json" autocomplete="off" spellcheck="false"></label><button id="load-questions" type="button">Load questions</button></div>
<div id="questions" class="grid" aria-live="polite"></div></section>
<section aria-labelledby="actions-heading"><h2 id="actions-heading">Typed Runtime and Approval actions</h2><p class="muted">Only the Runtime API can evaluate these requests. Approvals require an independent reviewer identity; queueing requires a release-approver or operator identity.</p>
<div class="actions"><label>Package <input id="package-id" autocomplete="off" spellcheck="false"></label><label>Assignee <input id="assignee" value="agent-alpha" autocomplete="off" spellcheck="false"></label><label>Lease ms <input id="lease-ms" inputmode="numeric" value="300000"></label><button id="allocate" type="button" disabled>Allocate package</button><button id="recover" type="button" disabled>Recover expired leases</button></div>
<div class="actions"><label>Candidate ID <input id="candidate-id" autocomplete="off" spellcheck="false"></label><label>Review note <input id="approval-reason" value="Reviewed against spec.json" autocomplete="off" spellcheck="false"></label><button id="approve" type="button" disabled>Approve candidate</button><button id="queue" type="button" disabled>Queue for merge</button></div>
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
  const elements = { token: $('token'), connect: $('connect'), refresh: $('refresh'), connection: $('connection'), mission: $('mission'), packages: $('packages'), runs: $('runs'), evidence: $('evidence'), packageId: $('package-id'), assignee: $('assignee'), leaseMs: $('lease-ms'), allocate: $('allocate'), recover: $('recover'), candidateId: $('candidate-id'), approvalReason: $('approval-reason'), approve: $('approve'), queue: $('queue'), questions: $('questions'), profileFile: $('profile-file'), loadQuestions: $('load-questions'), candidatePackage: $('candidate-package'), candidateTarget: $('candidate-target'), loadCandidate: $('load-candidate'), candidatePage: $('candidate-page'), evidenceBadge: $('evidence-badge'), stopPackage: $('stop-package'), runId: $('run-id'), stopReason: $('stop-reason'), watchRun: $('watch-run'), pauseRun: $('pause-run'), killRun: $('kill-run'), liveSteps: $('live-steps') };
  let token = '';
  let capabilities = { allocate: false, recover: false, approve: false, queue: false, answer: false, pause: false, kill: false };
  const MAX_RUNTIME_RESPONSE_BYTES = 1000000;
  function requestId() { return 'studio-' + (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2)); }
  function text(value) { if (value === null || value === undefined || value === '') return '—'; return Array.from(String(value), (character) => { const code = character.codePointAt(0); return code <= 31 || (code >= 127 && code <= 159) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) ? '�' : character; }).join(''); }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function element(tag, value, className) { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = text(value); return node; }
  function definition(parent, label, value) { parent.append(element('dt', label)); parent.append(element('dd', value)); }
  function card(title) { const node = element('article', undefined, 'card'); node.append(element('h3', title)); return node; }
  function setConnection(message, failed) { elements.connection.textContent = message; elements.connection.className = failed ? 'notice' : 'muted'; }
  function applyCapabilities(studio) { capabilities = studio && studio.actions ? studio.actions : { allocate: false, recover: false, approve: false, queue: false, answer: false, pause: false, kill: false }; elements.allocate.disabled = !capabilities.allocate; elements.recover.disabled = !capabilities.recover; if (elements.approve) elements.approve.disabled = !capabilities.approve; if (elements.queue) elements.queue.disabled = !capabilities.queue; if (elements.pauseRun) elements.pauseRun.disabled = !capabilities.pause; if (elements.killRun) elements.killRun.disabled = !capabilities.kill; }
  async function boundedJson(response) {
    const declared = Number((response.headers && response.headers.get && response.headers.get('content-length')) || 0);
    if (Number.isFinite(declared) && declared > MAX_RUNTIME_RESPONSE_BYTES) throw new Error('Runtime response exceeds ' + MAX_RUNTIME_RESPONSE_BYTES + ' bytes.');
    const reader = response.body && response.body.getReader ? response.body.getReader() : null;
    let text = '';
    if (!reader) text = await response.text();
    else {
      const decoder = new TextDecoder(); let bytes = 0;
      try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > MAX_RUNTIME_RESPONSE_BYTES) { await reader.cancel(); throw new Error('Runtime response exceeds ' + MAX_RUNTIME_RESPONSE_BYTES + ' bytes.'); } text += decoder.decode(next.value, { stream: true }); } text += decoder.decode(); }
      finally { if (reader.releaseLock) reader.releaseLock(); }
    }
    if (new TextEncoder().encode(text).byteLength > MAX_RUNTIME_RESPONSE_BYTES) throw new Error('Runtime response exceeds ' + MAX_RUNTIME_RESPONSE_BYTES + ' bytes.');
    try { return JSON.parse(text); } catch { throw new Error('Runtime returned an invalid response.'); }
  }
  async function call(method, params) {
    if (!token) throw new Error('A Runtime token is required.');
    const response = await fetch('/v1/runtime', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ schemaVersion: 1, requestId: requestId(), method, params }) });
    const body = await boundedJson(response);
    if (!response.ok || !body.ok) throw new Error((body && body.error && body.error.message) || 'Runtime request failed.');
    return body.result;
  }
  let lastQuestions = [];
  function renderQuestions(questions) {
    if (!elements.questions) return;
    lastQuestions = Array.isArray(questions) ? questions : [];
    clear(elements.questions);
    for (const q of lastQuestions) {
      const node = card('Question · ' + text(q.id));
      node.append(element('p', q.prompt));
      const list = document.createElement('dl');
      definition(list, 'Field', q.field); definition(list, 'Current', q.currentValue); definition(list, 'Suggested', q.suggestedValue); definition(list, 'Provenance', q.provenance); definition(list, 'Reason', q.reason);
      node.append(list);
      const row = document.createElement('div'); row.className = 'actions';
      const options = Array.isArray(q.options) ? q.options : null;
      let input;
      if (options && options.length > 0) {
        input = document.createElement('select');
        for (const option of options) { const opt = document.createElement('option'); opt.value = String(option); opt.textContent = text(option); input.append(opt); }
      } else {
        input = element('input'); input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
        if (q.suggestedValue !== undefined && q.suggestedValue !== null && typeof q.suggestedValue !== 'object') input.value = String(q.suggestedValue);
      }
      const reason = element('input'); reason.type = 'text'; reason.autocomplete = 'off'; reason.placeholder = 'waive reason (risk flags only)';
      const expires = element('input'); expires.type = 'date';
      const answerButton = element('button', 'Record answer'); answerButton.type = 'button'; answerButton.disabled = !capabilities.answer;
      const waiveButton = element('button', 'Waive'); waiveButton.type = 'button'; waiveButton.disabled = !capabilities.answer;
      answerButton.addEventListener('click', async () => {
        try {
          const profileFile = elements.profileFile.value.trim() || 'profile.json';
          let value = input.value;
          if (value === 'true') value = true; else if (value === 'false') value = false;
          if (value === 'waive') throw new Error('Use the Waive button with a reason and expiry date instead of the waive option.');
          const result = await call('answer', { profileFile, questionId: q.id, field: q.field, value });
          renderQuestions(result && result.remainingQuestions ? result.remainingQuestions : []);
          setConnection('Answer recorded with provenance user for ' + text(q.field) + '. Dependent questions are refreshed.', false);
        } catch (error) { setConnection(error.message, true); }
      });
      waiveButton.addEventListener('click', async () => {
        try {
          if (!reason.value.trim()) throw new Error('A waiver needs a reason.');
          if (!expires.value) throw new Error('A waiver needs an expiry date.');
          const profileFile = elements.profileFile.value.trim() || 'profile.json';
          const result = await call('answer', { profileFile, questionId: q.id, field: q.field, waive: { reason: reason.value.trim(), expires: expires.value } });
          renderQuestions(result && result.remainingQuestions ? result.remainingQuestions : []);
          setConnection('Waiver recorded for ' + text(q.field) + ' until ' + text(expires.value) + '.', false);
        } catch (error) { setConnection(error.message, true); }
      });
      row.append(input); row.append(answerButton); row.append(waiveButton); row.append(reason); row.append(expires);
      node.append(row);
      elements.questions.append(node);
    }
    if (!elements.questions.firstChild) elements.questions.append(element('p', 'No pending questions. The profile answers everything the current scan asks.', 'muted'));
  }
  async function loadQuestions() {
    if (!elements.questions) return;
    try {
      const profileFile = elements.profileFile.value.trim() || 'profile.json';
      const result = await call('get_questions', { profileFile });
      renderQuestions(result && result.questions ? result.questions : []);
    } catch (error) {
      clear(elements.questions);
      elements.questions.append(element('p', error.message, 'blocked'));
    }
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
    clear(elements.runs);
    for (const run of result.agentRuns || []) {
      const node = card('Agent run · ' + run.packageId); const list = document.createElement('dl');
      definition(list, 'Adapter', run.adapter); definition(list, 'Outcome', run.outcome); definition(list, 'Run ID', run.id); definition(list, 'Output digest', run.output && run.output.digest); definition(list, 'Summary', run.output && run.output.summary);
      node.append(list); elements.runs.append(node);
    }
    for (const item of result.delivery || []) {
      const receipt = item.candidate || item.verification || item.approval || item.queue || item.forge;
      const type = item.candidate ? 'Candidate' : item.verification ? 'Verification' : item.approval ? 'Approval' : item.queue ? 'Queue' : 'Forge plan';
      const node = card(type + ' · ' + item.packageId); const list = document.createElement('dl');
      definition(list, 'Receipt ID', receipt && receipt.id); definition(list, 'Candidate SHA', receipt && receipt.candidateSha); definition(list, 'Target SHA', receipt && receipt.targetSha); definition(list, 'Policy digest', receipt && receipt.policyDigest);
      if (item.forge) {
        const plan = item.forge.plan || {};
        definition(list, 'Provider', plan.provider); definition(list, 'Repository', plan.repository); definition(list, 'Head ref', plan.headRef); definition(list, 'Base ref', plan.baseRef); definition(list, 'Plan title', plan.title); definition(list, 'Required checks', (plan.requiredChecks || []).join(', ')); definition(list, 'Merge request', plan.allowMergeRequest ? 'allowed' : 'disabled'); definition(list, 'Exported at', item.forge.exportedAt);
      } else definition(list, 'Outcome', receipt && receipt.outcome);
      node.append(list); elements.runs.append(node);
    }
    if (!elements.runs.firstChild) elements.runs.append(element('p', 'No bounded adapter or delivery receipts yet.', 'muted'));
  }
  function renderEvidence(result) { clear(elements.evidence); const node = card('Traceability'); const list = document.createElement('dl'); for (const pkg of result.packages || []) definition(list, pkg.id + ' requirements', (pkg.requirements || []).join(', ')); definition(list, 'Recent event window', (result.recentEvents || []).length + ' event(s) from the bounded current-status window'); definition(list, 'Historic evidence', 'Not displayed here. Request cursor-paged Runtime events when reviewing durable history.'); definition(list, 'Delivery receipts in recent window', (result.delivery || []).length); definition(list, 'Packet digest', result.runtime && result.runtime.packetDigest); node.append(list); elements.evidence.append(node); const chain = result.studio && result.studio.evidenceChain; if (chain && chain.exists) { const chainCard = card('Hash-chained audit ledger'); const chainList = document.createElement('dl'); definition(chainList, 'Chain integrity', chain.ok ? 'verified' : 'tampered at seq ' + chain.firstBrokenSeq); definition(chainList, 'Entries', chain.entries); definition(chainList, 'Head SHA-256', chain.headHash); for (const item of chain.recent || []) definition(chainList, 'seq ' + item.seq + ' · ' + item.kind, item.subject + ' (' + item.actor + ')'); chainCard.append(chainList); for (const error of chain.errors || []) chainCard.append(element('p', error, 'blocked')); elements.evidence.append(chainCard); } const catalog = result.studio && result.studio.catalog; if (catalog) { const catalogCard = card('Signed content catalog'); const catalogList = document.createElement('dl'); definition(catalogList, 'Trust state', catalog.ok ? 'verified' : 'degraded'); definition(catalogList, 'Root digest', catalog.trustedRoot && catalog.trustedRoot.digest); for (const item of catalog.catalogs || []) { definition(catalogList, item.id + ' publisher(s)', (item.packages || []).map((pkg) => pkg.publisher && pkg.publisher.id).join(', ')); definition(catalogList, item.id + ' content digest', item.indexDigest); } catalogCard.append(catalogList); for (const error of catalog.errors || []) catalogCard.append(element('p', error, 'blocked')); elements.evidence.append(catalogCard); } }
  function render(result) { applyCapabilities(result.studio); renderMission(result); renderPackages(result); renderRuns(result); renderEvidence(result); setConnection(result.ok === false ? 'Connected, but Runtime reports a degraded/read-only state. Read the warnings above.' : 'Connected to local Runtime. Status is authoritative.', result.ok === false); }
  async function refresh() { try { render(await call('status', {})); } catch (error) { applyCapabilities(null); setConnection(error.message, true); } await loadQuestions(); }
  elements.connect.addEventListener('click', async () => { token = elements.token.value; elements.token.value = ''; await refresh(); if (token) elements.refresh.disabled = false; });
  elements.refresh.addEventListener('click', refresh);
  if (elements.loadQuestions) elements.loadQuestions.addEventListener('click', loadQuestions);
  elements.allocate.addEventListener('click', async () => { try { if (!globalThis.crypto || !crypto.randomUUID) throw new Error('This browser cannot generate a lease capability. Use the CLI instead.'); const leaseMs = Number(elements.leaseMs.value); const leaseToken = 'lease-' + crypto.randomUUID(); const result = await call('allocate', { packageId: elements.packageId.value, assignee: { role: 'implementer', id: elements.assignee.value }, leaseMs, leaseToken }); await refresh(); setConnection('Allocation created. Copy this lease capability now; Studio will not retain it: ' + result.leaseToken, false); } catch (error) { setConnection(error.message, true); } });
  elements.recover.addEventListener('click', async () => { try { await call('recover', {}); await refresh(); } catch (error) { setConnection(error.message, true); } });
  if (elements.approve) elements.approve.addEventListener('click', async () => { try { await call('approve', { packageId: elements.packageId.value, candidateId: elements.candidateId.value, reason: elements.approvalReason.value }); await refresh(); setConnection('Candidate approved and recorded in evidence ledger.', false); } catch (error) { setConnection(error.message, true); } });
  if (elements.queue) elements.queue.addEventListener('click', async () => { try { await call('queue', { packageId: elements.packageId.value, candidateId: elements.candidateId.value, reason: elements.approvalReason.value }); await refresh(); setConnection('Approved candidate queued for governed delivery.', false); } catch (error) { setConnection(error.message, true); } });

  /* ------------------------- P3.6 candidate page ------------------------- */
  function renderMatrix(rows) {
    const table = document.createElement('table');
    const head = document.createElement('tr');
    for (const label of ['Requirement', 'Title', 'Area', 'Verify', 'Anchored in candidate']) head.append(element('th', label));
    table.append(head);
    for (const row of rows) {
      const tr = document.createElement('tr');
      tr.append(element('td', row.id));
      tr.append(element('td', row.title));
      tr.append(element('td', row.area));
      tr.append(element('td', row.verify));
      tr.append(element('td', row.anchored ? 'yes · ' + row.anchoredFiles.join(', ') : 'NO ANCHOR'));
      table.append(tr);
    }
    return table;
  }
  function renderCandidate(page) {
    if (!elements.candidatePage) return;
    clear(elements.candidatePage);
    const badge = elements.evidenceBadge;
    if (badge) {
      const chain = page.evidenceChain;
      if (chain && chain.exists && chain.ok) { badge.textContent = '✓ evidence chain verified · ' + chain.entries + ' entries'; badge.className = 'state'; }
      else if (chain && chain.exists) { badge.textContent = '✗ evidence chain tampered at seq ' + chain.firstBrokenSeq; badge.className = 'blocked'; }
      else { badge.textContent = 'no evidence chain yet'; badge.className = 'muted'; }
    }
    const summary = card('Candidate · ' + (page.candidate && page.candidate.id));
    const list = document.createElement('dl');
    definition(list, 'Package', page.package && page.package.id); definition(list, 'State', page.package && page.package.state);
    definition(list, 'Candidate SHA', page.candidate && page.candidate.candidateSha); definition(list, 'Target SHA', page.candidate && page.candidate.targetSha);
    definition(list, 'Packet digest', page.candidate && page.candidate.packetDigest); definition(list, 'Implementer model', page.candidate && page.candidate.implementerModelId);
    definition(list, 'Verification', page.verification ? page.verification.outcome : 'not run'); definition(list, 'Review verdict', page.review ? page.review.verdict : 'not reviewed');
    definition(list, 'Blocking findings', page.review ? page.review.blockingFindings : '—'); definition(list, 'Human sign-off required', page.review ? String(page.review.requiresHumanSignoff) : '—');
    summary.append(list); elements.candidatePage.append(summary);

    const matrix = card('Requirement coverage matrix');
    matrix.append(renderMatrix(page.coverage || []));
    const unproven = (page.coverage || []).filter((row) => !row.anchored).length;
    matrix.append(element('p', unproven === 0 ? 'Every requirement carries an @req anchor in the frozen candidate.' : unproven + ' requirement(s) have no test anchor in the candidate tree.', unproven === 0 ? 'muted' : 'blocked'));
    elements.candidatePage.append(matrix);

    const mutation = card('Mutation score');
    if (page.mutation && page.mutation.reported) {
      for (const check of page.mutation.checks) {
        const mlist = document.createElement('dl');
        definition(mlist, 'Check', check.id); definition(mlist, 'Kind', check.kind); definition(mlist, 'Passed', String(check.passed));
        definition(mlist, 'Summary', check.output && check.output.summary);
        mutation.append(mlist);
      }
    } else mutation.append(element('p', 'No mutation gate reported for this candidate.', 'muted'));
    elements.candidatePage.append(mutation);

    const sandbox = card('Sandbox / verification receipt');
    if (page.verification) {
      const vlist = document.createElement('dl');
      definition(vlist, 'Outcome', page.verification.outcome); definition(vlist, 'Integration tree', page.verification.integrationTree);
      for (const check of page.verification.checks || []) definition(vlist, check.kind + ' (' + check.id + ')', (check.passed ? 'PASS — ' : 'FAIL — ') + (check.output && check.output.summary));
      sandbox.append(vlist);
    } else sandbox.append(element('p', 'Candidate has not been verified.', 'blocked'));
    elements.candidatePage.append(sandbox);

    const findings = card('Independent review findings');
    if (page.review) {
      const categories = page.review.categories || {};
      let seen = false;
      for (const name of Object.keys(categories)) {
        const value = categories[name];
        if (value === 'none') continue;
        for (const finding of value || []) {
          seen = true;
          findings.append(element('p', '[' + finding.severity + '] ' + name + ' · ' + finding.requirement + ' · ' + finding.file + ' — ' + (finding.summary || finding.fix)));
        }
      }
      if (!seen) findings.append(element('p', 'No findings recorded against this candidate.', 'muted'));
    } else findings.append(element('p', 'No independent review recorded yet.', 'blocked'));
    elements.candidatePage.append(findings);

    const diffCard = card('Candidate diff' + (page.diff && page.diff.truncated ? ' (truncated)' : ''));
    const pre = document.createElement('pre');
    pre.textContent = page.diff && page.diff.text ? page.diff.text : 'Empty diff: the candidate matches its target.';
    diffCard.append(pre);
    elements.candidatePage.append(diffCard);

    const cost = card('Cost');
    const clist = document.createElement('dl');
    definition(clist, 'Total tokens', page.cost && page.cost.totals && page.cost.totals.totalTokens); definition(clist, 'Total cost USD', page.cost && page.cost.totals && page.cost.totals.costUsd);
    for (const run of (page.cost && page.cost.runs) || []) definition(clist, 'Run ' + run.id, run.adapter + ' · ' + run.outcome + ' · ' + (run.modelId || 'no model') + ' · ' + (run.usage ? run.usage.totalTokens + ' tokens' : 'no usage'));
    cost.append(clist); elements.candidatePage.append(cost);
  }
  async function loadCandidate() {
    if (!elements.candidatePage) return;
    try {
      const params = { packageId: elements.candidatePackage.value.trim() };
      const target = elements.candidateTarget.value.trim();
      if (target) params.candidateId = target;
      const page = await call('candidate_detail', params);
      renderCandidate(page);
      if (elements.candidateId && !elements.candidateId.value && page.candidate) elements.candidateId.value = page.candidate.id;
      setConnection('Candidate page loaded for review.', false);
    } catch (error) {
      clear(elements.candidatePage);
      elements.candidatePage.append(element('p', error.message, 'blocked'));
      setConnection(error.message, true);
    }
  }
  if (elements.loadCandidate) elements.loadCandidate.addEventListener('click', loadCandidate);

  /* --------------------- P3.6 live steps (SSE over fetch) ---------------- */
  let watching = false;
  let lastSequence = 0;
  function appendStep(line, className) {
    if (!elements.liveSteps) return;
    const node = element('p', line, className);
    elements.liveSteps.append(node);
    while (elements.liveSteps.childNodes.length > 200) elements.liveSteps.removeChild(elements.liveSteps.firstChild);
  }
  async function watchLoop() {
    watching = true;
    if (elements.watchRun) elements.watchRun.textContent = 'Watching…';
    while (watching && token) {
      try {
        const response = await fetch('/v1/runtime/stream' + (lastSequence ? '?after=' + lastSequence : ''), { headers: { authorization: 'Bearer ' + token } });
        if (!response.ok || !response.body) throw new Error('Runtime event stream refused (HTTP ' + response.status + ').');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
          let split = buffer.indexOf('\\n\\n');
          while (split >= 0) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const dataLine = frame.split('\\n').find((line) => line.startsWith('data: '));
            if (dataLine) {
              try {
                const event = JSON.parse(dataLine.slice(6));
                lastSequence = Math.max(lastSequence, Number(event.sequence) || 0);
                appendStep('seq ' + event.sequence + ' · ' + event.type + (event.packageId ? ' · ' + event.packageId : '') + (event.runStop ? ' · ' + event.runStop.action + ' (' + event.runStop.reason + ')' : ''), event.runStop ? 'blocked' : 'muted');
              } catch {}
            }
            split = buffer.indexOf('\\n\\n');
          }
        }
      } catch (error) {
        if (watching) appendStep('stream error: ' + error.message + ' — retrying in 2s', 'blocked');
      }
      if (watching) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (elements.watchRun) elements.watchRun.textContent = 'Watch events';
  }
  if (elements.watchRun) elements.watchRun.addEventListener('click', async () => {
    if (watching) { watching = false; appendStep('watch stopped', 'muted'); return; }
    watchLoop();
  });
  async function stopRun(action) {
    try {
      const params = { packageId: elements.stopPackage.value.trim(), runId: elements.runId.value.trim(), reason: elements.stopReason.value.trim() };
      const result = await call(action, params);
      appendStep('seq ' + result.replayableSequence + ' · run-stop ' + action + ' recorded for ' + params.runId, 'blocked');
      setConnection('Run ' + action + ' recorded in the Runtime ledger.', false);
    } catch (error) { setConnection(error.message, true); }
  }
  if (elements.pauseRun) elements.pauseRun.addEventListener('click', () => stopRun('pause'));
  if (elements.killRun) elements.killRun.addEventListener('click', () => stopRun('kill'));

  /* --------------------------- P3.6 keyboard flow ------------------------ */
  if (document.addEventListener) document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const key = event.key.toLowerCase();
    if (key === 'r' && elements.refresh && !elements.refresh.disabled) { elements.refresh.click(); event.preventDefault(); }
    else if (key === 'c' && elements.loadCandidate) { elements.loadCandidate.click(); event.preventDefault(); }
    else if (key === 'a' && elements.approve && !elements.approve.disabled) { elements.approve.click(); event.preventDefault(); }
    else if (key === 'q' && elements.queue && !elements.queue.disabled) { elements.queue.click(); event.preventDefault(); }
    else if (key === 'p' && elements.pauseRun && !elements.pauseRun.disabled) { elements.pauseRun.click(); event.preventDefault(); }
    else if (key === 'k' && elements.killRun && !elements.killRun.disabled) { elements.killRun.click(); event.preventDefault(); }
    else if (key === '?' || (key === '/' && event.shiftKey)) { setConnection('Keyboard: r refresh · c load candidate · a approve · q queue · p pause run · k kill run. Fill Package/Candidate/Run ID fields first.', false); event.preventDefault(); }
  });
})();`;
}

/** Runtime API status decoration: a UI hint, never an authorization decision. */
export function studioCapabilities(actor) {
  return {
    allocate: ['operator', 'runtime'].includes(actor?.role),
    recover: ['operator', 'runtime'].includes(actor?.role),
    transition: ['implementer', 'reviewer', 'release-approver', 'operator', 'runtime', 'forge'].includes(actor?.role),
    approve: actor?.role === 'reviewer',
    queue: ['release-approver', 'operator'].includes(actor?.role),
    questions: true,
    answer: ['operator', 'reviewer', 'release-approver'].includes(actor?.role),
    pause: ['operator', 'release-approver', 'runtime'].includes(actor?.role),
    kill: ['operator', 'release-approver', 'runtime'].includes(actor?.role)
  };
}
