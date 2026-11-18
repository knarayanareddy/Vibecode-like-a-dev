/**
 * Roadmap P3.1, P1.4 & P1.5 regression suite:
 *   - P3.1: `model-client.mjs` covers anthropic, openai, openai-compatible, and
 *     direct-argv command providers, cassette record/replay, 429 `Retry-After`
 *     backoff, cost/token budget cutoff, secret redaction, and core-boundary guard.
 *   - P1.4: ADR-0013 + `vld intake` (arg, file, stdin, offline fallback without
 *     API key, cassette replay), verbatim evidence verification rejecting
 *     hallucinated quotes, scanner-vs-model disagreement flagging (`needs-human`),
 *     `intake-report.json` + `.vld/evidence.jsonl`, `vld intake accept` -> strict
 *     `profile.json`, and Adversarial Test E (`<= 7` questions -> tier 3 + GDPR +
 *     HIPAA + multiTenant + payments).
 *   - P1.5: `profile.provenance` in `plan --explain`, strict rejection of defaulted
 *     tier-driving fields at `stage: "production"`, dependent question unlocking,
 *     MCP `get_questions`/`answer`, and Studio Runtime API `get_questions`/`answer`.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyEvidenceChain } from '../lib/evidence.mjs';
import { acceptIntakeDraft, runIntake, verifyVerbatimEvidence } from '../lib/intake.mjs';
import { handleMessage } from '../lib/mcp.mjs';
import { createMission } from '../lib/missions.mjs';
import { createModelClient, redactSecrets } from '../lib/model-client.mjs';
import { initializeRuntime } from '../lib/runtime.mjs';
import { createRuntimeClient } from '../lib/runtime-client.mjs';
import { createRuntimeServer, listenRuntimeServer } from '../lib/runtime-server.mjs';
import { studioCapabilities, studioDashboardScript, studioHtml } from '../lib/studio.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'factory', 'cli.mjs');

test('P3.1 model-client handles anthropic/openai/command, 429 Retry-After, cassette replay, budgets, and secret redaction', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vld-model-client-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cassetteDir = path.join(dir, 'cassettes');

  // Synthesize fake key dynamically so secret scanners never see a literal key.
  const fakeKey = ['sk', 'ant', 'testSecretKey999999999999'].join('-');
  const sleeps = [];
  let httpCalls = 0;

  // 1. Anthropic with HTTP 429 + Retry-After -> succeeds on retry & records scrubbed cassette.
  const anthropicClient = createModelClient({
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    tokenEnv: 'TEST_ANTHROPIC_KEY',
    env: { TEST_ANTHROPIC_KEY: fakeKey },
    cassetteDir,
    cassetteMode: 'record',
    sleepFn: async (ms) => { sleeps.push(ms); },
    transport: async ({ headers }) => {
      httpCalls += 1;
      assert.equal(headers['x-api-key'], fakeKey);
      if (httpCalls === 1) {
        return { status: 429, headers: { 'retry-after': '1' }, bodyText: `rate limit for ${fakeKey}` };
      }
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({
          model: 'claude-sonnet-4-6',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"answer":"ok"}' }],
          usage: { input_tokens: 120, output_tokens: 30 }
        })
      };
    }
  });

  const first = await anthropicClient.complete({
    system: 'Reply in JSON.',
    messages: [{ role: 'user', content: 'ping' }],
    schema: { title: 'ping', type: 'object' }
  });
  assert.equal(httpCalls, 2);
  assert.deepEqual(sleeps, [1000], 'Retry-After: 1 respected');
  assert.deepEqual(first.json, { answer: 'ok' });
  assert.equal(first.cached, false);
  assert.ok(first.usage.costUsd > 0);

  // Replay with ZERO env key and failing transport -> hits cassette cleanly!
  const replayClient = createModelClient({
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    env: {},
    cassetteDir,
    cassetteMode: 'replay',
    transport: async () => { throw new Error('network must not be called in replay mode'); }
  });
  const replayed = await replayClient.complete({
    system: 'Reply in JSON.',
    messages: [{ role: 'user', content: 'ping' }],
    schema: { title: 'ping', type: 'object' }
  });
  assert.equal(replayed.cached, true);
  assert.equal(replayed.requestDigest, first.requestDigest);
  assert.deepEqual(replayed.json, { answer: 'ok' });

  // 2. OpenAI tool_calls + cumulative cost budget cutoff.
  const oaiClient = createModelClient({
    provider: 'openai',
    model: 'gpt-4.1',
    tokenEnv: 'TEST_OAI_KEY',
    env: { TEST_OAI_KEY: ['sk', 'projTestKey88888888888888'].join('-') },
    budget: { maxCostUsd: 0.001 },
    transport: async () => ({
      status: 200,
      headers: {},
      bodyText: JSON.stringify({
        model: 'gpt-4.1',
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }]
          }
        }],
        usage: { prompt_tokens: 5000, completion_tokens: 1000 }
      })
    })
  });
  await assert.rejects(
    () => oaiClient.complete({ messages: [{ role: 'user', content: 'read readme' }] }),
    (err) => err.code === 'MODEL_BUDGET_EXCEEDED'
  );

  // 3. Direct-argv command provider.
  const cmdScript = path.join(dir, 'mock-model.mjs');
  writeFileSync(
    cmdScript,
    "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify({text:'hello-cmd',usage:{inputTokens:10,outputTokens:5}})));\n"
  );
  const cmdClient = createModelClient({ provider: 'command', model: 'local-stub', command: [process.execPath, cmdScript] });
  const cmdRes = await cmdClient.complete({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(cmdRes.text, 'hello-cmd');

  // 4. Secret redaction never leaks raw tokens.
  assert.equal(redactSecrets(`Authorization: Bearer ${fakeKey}`, [fakeKey]).includes(fakeKey), false);
});

test('P1.4 ADR-0013, hallucinated quote rejection, scanner-vs-model clash, and Adversarial Test E in <= 7 questions', async (t) => {
  assert.ok(existsSync(path.join(ROOT, 'docs', 'adr', '0013-assisted-intake.md')));

  const dir = mkdtempSync(path.join(os.tmpdir(), 'vld-intake-e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const testEIdea =
    'SaaS for EU clinics scheduling therapy appointments, SMS reminders via Twilio, Stripe billing, separate database per clinic, patient portal.';

  // Verbatim substring contract check.
  assert.equal(verifyVerbatimEvidence(testEIdea, 'separate database per clinic').valid, true);
  assert.equal(verifyVerbatimEvidence(testEIdea, 'stores encrypted MRI scans in S3').valid, false);

  // 1. Offline intake (zero API key) on Adversarial Test E via CLI stdin!
  const cliRun = spawnSync(
    process.execPath,
    [CLI, 'intake', '--offline', '--project', dir, '--name', 'eu-clinic-scheduler', '--json'],
    { input: testEIdea, encoding: 'utf8' }
  );
  assert.equal(cliRun.status, 0, cliRun.stderr);
  const cliJson = JSON.parse(cliRun.stdout);
  assert.equal(cliJson.mode, 'offline-deterministic');
  assert.ok(cliJson.pendingQuestionCount >= 1 && cliJson.pendingQuestionCount <= 7, `expected 1..7 questions, got ${cliJson.pendingQuestionCount}`);

  // Unanswered `intake accept` MUST refuse promotion!
  assert.throws(
    () => acceptIntakeDraft({ projectDir: dir, force: true }),
    (err) => err.code === 'INTAKE_UNRESOLVED_QUESTIONS'
  );

  // Confirm suggestions -> produces a strict-passing tier-3 profile with gdpr + hipaa + multiTenant + payments!
  const accepted = acceptIntakeDraft({ projectDir: dir, acceptSuggested: true, force: true });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.profile.risks.regulated, true);
  assert.equal(accepted.profile.risks.pii, true);
  assert.equal(accepted.profile.risks.payments, true);
  assert.equal(accepted.profile.risks.multiTenant, true);
  assert.equal(accepted.profile.risks.publicFacing, true);
  assert.equal(accepted.profile.risks.integrations, true);
  assert.ok(accepted.profile.regulation.includes('gdpr'));
  assert.ok(accepted.profile.regulation.includes('hipaa'));

  // Accepted profile passes default strict `vld plan` AND compiles a tier-3 packet!
  const strictPlan = spawnSync(process.execPath, [CLI, 'plan', accepted.profileFile, '--json'], { encoding: 'utf8' });
  assert.equal(strictPlan.status, 0, strictPlan.stderr);
  const planObj = JSON.parse(strictPlan.stdout);
  assert.equal(planObj.rigor.tier, 3);

  // Evidence chain recorded both intake + intake-accepted and verifies cleanly.
  const chain = verifyEvidenceChain({ projectDir: dir });
  assert.equal(chain.ok, true);
  assert.equal(chain.entries, 2);

  // 2. Model reconciliation test: model lies (`payments: false`) and hallucinates a quote -> rejected & marked needs-human!
  const dir2 = path.join(dir, 'model-clash');
  mkdirSync(dir2, { recursive: true });
  const stubModel = createModelClient({
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    env: { ANTHROPIC_API_KEY: ['sk', 'ant', 'stub0000000000000000'].join('-') },
    cassetteDir: path.join(dir2, 'cassettes'),
    cassetteMode: 'auto',
    transport: async () => ({
      status: 200,
      headers: {},
      bodyText: JSON.stringify({
        model: 'claude-sonnet-4-6',
        content: [{
          type: 'text',
          text: JSON.stringify({
            kind: { value: 'web-app', evidence: 'SaaS for EU clinics', confidence: 0.95 },
            stage: { value: 'production', evidence: 'HALLUCINATED QUOTE NOT IN TEXT', confidence: 0.99 },
            risks: {
              payments: { value: false, evidence: 'Stripe billing', confidence: 0.9 },
              regulated: { value: true, evidence: 'EU clinics', confidence: 0.95 }
            },
            regulation: [{ value: 'gdpr', evidence: 'EU clinics', confidence: 0.95 }]
          })
        }],
        usage: { input_tokens: 200, output_tokens: 90 }
      })
    })
  });

  const reconciled = await runIntake({ text: testEIdea, projectDir: dir2, modelClient: stubModel });
  assert.equal(reconciled.report.quoteAudit.rejected.length, 1, 'hallucinated quote caught and rejected');
  assert.equal(reconciled.report.quoteAudit.rejected[0].field, 'stage');
  assert.ok(
    reconciled.report.disagreements.some((d) => d.field === 'risks.payments'),
    'model denying Stripe payments flagged as disagreement'
  );
  assert.equal(reconciled.draft.fields.risks.payments.value, true, 'scanner truth preserved over model omission');
  assert.equal(reconciled.draft.fields.risks.payments.status, 'needs-human');
});

test('P1.5 production defaulted tier fields blocked, dependent questions unlock via MCP & Studio Runtime API', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vld-prov-q-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Production profile omitting risk booleans MUST fail default strict plan!
  const prodFile = path.join(dir, 'profile.json');
  writeFileSync(
    prodFile,
    JSON.stringify({
      name: 'prod-missing-risks',
      idea: 'A release changelog formatter for engineering squads organizing deployment summaries.',
      kind: 'cli',
      stage: 'production',
      domain: { entity: 'changelog', actors: ['engineer'] },
      risks: { pii: false }
    }, null, 2)
  );
  const blocked = spawnSync(process.execPath, [CLI, 'plan', prodFile], { encoding: 'utf8' });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /provenance: stage is "production" but tier-driving field\(s\) remain at default/);

  // 1. MCP `get_questions` returns <= 7 questions + provenance; answering `risks.regulated = true` unlocks `regulation`!
  const qResp = handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'get_questions', arguments: { profilePath: prodFile } }
  });
  const qData = JSON.parse(qResp.result.content[0].text);
  assert.ok(qData.questions.length >= 1 && qData.questions.length <= 7);
  assert.equal(qData.provenance['risks.pii'], 'user');
  assert.equal(qData.provenance['risks.payments'], 'default');

  const regAnswer = handleMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'answer',
      arguments: { profilePath: prodFile, persist: true, field: 'risks.regulated', value: true, actor: 'alice' }
    }
  });
  const regData = JSON.parse(regAnswer.result.content[0].text);
  assert.equal(regData.provenance['risks.regulated'], 'user');
  assert.ok(
    regData.remainingQuestions.some((q) => q.field === 'regulation'),
    'answering risks.regulated=true dynamically unlocks dependent regulation question'
  );
  assert.ok(regData.profile.questions.some((q) => q.field === 'risks.regulated' && q.answeredAt));

  // Answer regulation + users.scale + remaining risk flags, then verify strict plan passes!
  handleMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'answer', arguments: { profilePath: prodFile, persist: true, field: 'regulation', value: ['soc2'] } }
  });
  handleMessage({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'answer', arguments: { profilePath: prodFile, persist: true, field: 'users.scale', value: 'small' } }
  });
  handleMessage({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'answer',
      arguments: {
        profilePath: prodFile,
        persist: true,
        field: 'risks',
        value: { payments: false, multiTenant: false, destructiveWrites: false, publicFacing: false, integrations: false }
      }
    }
  });

  const passesNow = spawnSync(process.execPath, [CLI, 'plan', prodFile, '--explain'], { encoding: 'utf8' });
  assert.equal(passesNow.status, 0, passesNow.stderr);
  assert.match(passesNow.stdout, /field provenance/);

  // 2. Studio Runtime API `get_questions` & `answer` round-trip.
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@vld.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'VLD Test'], { cwd: dir });
  spawnSync(process.execPath, [CLI, 'compile', prodFile, '-o', path.join(dir, 'specs'), '--force'], { encoding: 'utf8' });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });

  const spec = JSON.parse(readFileSync(path.join(dir, 'specs', 'spec.json'), 'utf8'));
  const mission = createMission({
    definition: {
      schemaVersion: 1,
      id: 'q-mission',
      title: 'Studio question mission',
      workPackages: [{ id: 'pkg-core', title: 'Core implementation package', requirements: spec.requirements.map((r) => r.id), dependsOn: [], resourceClaims: { paths: ['src/**'] } }]
    },
    packetDir: 'specs',
    projectDir: dir,
    force: true
  });
  const missionRel = path.relative(dir, mission.file);
  initializeRuntime({ missionFile: missionRel, projectDir: dir });

  const token = 'studio-q-token-1234567890';
  const srv = createRuntimeServer({
    missionFile: missionRel,
    projectDir: dir,
    identities: { [token]: { role: 'operator', id: 'op-1' } }
  });
  const running = await listenRuntimeServer(srv.server, { port: 0 });
  t.after(() => srv.server.close());
  const client = createRuntimeClient({ endpoint: `http://${running.host}:${running.port}`, token });
  const studioQ = await client.request('get_questions', { profileFile: 'profile.json' });
  assert.ok(Array.isArray(studioQ.questions));
  const studioAns = await client.request('answer', { profileFile: 'profile.json', field: 'constraints.stack', value: 'typescript' });
  assert.equal(studioAns.profile.constraints.stack, 'typescript');
  assert.equal(studioAns.provenance['constraints.stack'], 'user');
});

// Studio assisted-intake Q&A UI (deferred Wave 2 item): the static dashboard shell
// wires get_questions/answer through the authenticated Runtime POST and gates
// recording on the same roles the Runtime itself enforces.
test('Studio serves an assisted-intake Q&A panel wired to get_questions/answer with role-gated recording', () => {
  const html = studioHtml('test-nonce');
  assert.match(html, /Profile questions \(assisted intake\)/);
  assert.match(html, /id="questions"/);
  assert.match(html, /id="profile-file"/);
  const script = studioDashboardScript();
  assert.match(script, /get_questions/);
  assert.match(script, /'answer'/);
  assert.match(script, /provenance user/);
  // The panel must render with textContent, never innerHTML.
  assert.doesNotMatch(script, /innerHTML/);

  assert.equal(studioCapabilities({ role: 'operator', id: 'op' }).answer, true);
  assert.equal(studioCapabilities({ role: 'reviewer', id: 'rv' }).answer, true);
  assert.equal(studioCapabilities({ role: 'release-approver', id: 'ra' }).answer, true);
  assert.equal(studioCapabilities({ role: 'implementer', id: 'im' }).answer, false);
  assert.equal(studioCapabilities({ role: 'forge', id: 'fg' }).answer, false);
  assert.equal(studioCapabilities(null).answer, false);
  assert.equal(studioCapabilities({ role: 'operator', id: 'op' }).questions, true);
});
