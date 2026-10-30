import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { enableModules } from '../lib/modules.mjs';
import {
  completeWorkflowStep,
  listWorkflows,
  runWorkflow,
  validateWorkflow,
  workflowStatus
} from '../lib/workflows.mjs';

const PROFILE = {
  name: 'workflow-lab',
  idea: 'A compact project used to prove that VLD workflows are typed, resumable and evidence led.',
  kind: 'web-app',
  stage: 'mvp',
  users: { scale: 'small' },
  traits: ['auth'],
  risks: { pii: true },
  constraints: { team: 2, weeks: 4, stack: 'typescript', mustUse: [] }
};

function fixture(t) {
  const project = mkdtempSync(path.join(os.tmpdir(), 'vld-workflow-'));
  const profile = path.join(project, 'profile.json');
  writeFileSync(profile, `${JSON.stringify(PROFILE, null, 2)}\n`);
  enableModules({ projectDir: project, ids: 'review,qa' });
  t.after(() => rmSync(project, { recursive: true, force: true }));
  return { project, profile, packet: path.join(project, 'specs') };
}

test('builtin workflows validate and reject cycles, arbitrary shell-like actions, and malformed handoffs', () => {
  assert.deepEqual(listWorkflows().errors, []);
  const malformed = {
    schemaVersion: 1,
    id: 'bad-flow',
    version: '0.1.0',
    title: 'Bad flow',
    summary: 'A malformed workflow is rejected before it can write any project state.',
    requiresModules: [],
    steps: [
      { id: 'first-step', type: 'command', description: 'This would attempt to run an untrusted command and must be rejected.', run: ['sh', '-c', 'rm -rf .'], dependsOn: ['second-step'] },
      { id: 'second-step', type: 'agent-handoff', description: 'This malformed handoff participates in a dependency cycle for the test.', dependsOn: ['first-step'] }
    ]
  };
  const errors = validateWorkflow(malformed).join('\n');
  assert.match(errors, /only plan, compile, verify are allowed/);
  assert.match(errors, /workflow dependency cycle/);
  assert.match(errors, /agent handoff needs a module id/);
});

test('discovery workflow starts only on explicit execute, runs safe VLD commands, and resumes through human evidence', (t) => {
  const { project, profile } = fixture(t);

  const preview = runWorkflow({ id: 'discovery', projectDir: project, context: { profile }, execute: false });
  assert.equal(preview.started, false);
  assert.equal(existsSync(path.join(project, '.vld', 'workflows', 'discovery.json')), false, 'a preview does not persist runtime state');
  assert.equal(preview.steps[0].status, 'ready');

  const started = runWorkflow({ id: 'discovery', projectDir: project, context: { profile }, execute: true });
  assert.equal(started.created, true);
  assert.deepEqual(started.executed, [], 'human input blocks command execution');
  assert.equal(started.steps.find((step) => step.id === 'capture-intent').status, 'ready');
  assert.throws(
    () => completeWorkflowStep({ id: 'discovery', stepId: 'capture-intent', projectDir: project, evidence: 'short' }),
    /manual completion needs --evidence/
  );

  completeWorkflowStep({ id: 'discovery', stepId: 'capture-intent', projectDir: project, evidence: 'Profile risks and non-goals reviewed by product owner.' });
  const planned = runWorkflow({ id: 'discovery', projectDir: project, execute: true });
  assert.deepEqual(planned.executed.map((entry) => [entry.id, entry.status]), [['plan', 'complete']]);
  assert.equal(planned.steps.find((step) => step.id === 'draft-brief').status, 'ready');
  assert.equal(planned.state.steps.plan.evidence.type, 'command');
  assert.match(planned.state.steps.plan.evidence.outputDigest, /^[a-f0-9]{64}$/);
  assert.equal(planned.state.steps.plan.evidence.stdout, undefined, 'runtime state stores a digest, not arbitrary command output');

  completeWorkflowStep({ id: 'discovery', stepId: 'draft-brief', projectDir: project, evidence: 'Product brief at docs/product-brief.md links its assumptions to the plan.' });
  completeWorkflowStep({ id: 'discovery', stepId: 'approve-brief', projectDir: project, evidence: 'Brief approved for architecture work by the accountable product owner.' });
  assert.ok(workflowStatus({ id: 'discovery', projectDir: project }).steps.every((step) => step.status === 'complete'));
});

test('feature workflow compiles and verifies a real packet, but executable steps cannot be manually self-certified', (t) => {
  const { project, profile, packet } = fixture(t);
  runWorkflow({ id: 'feature-delivery', projectDir: project, context: { profile, packet }, execute: true });
  completeWorkflowStep({ id: 'feature-delivery', stepId: 'confirm-intent', projectDir: project, evidence: 'Scope, risk flags and timeline reviewed before work begins.' });
  let result = runWorkflow({ id: 'feature-delivery', projectDir: project, execute: true });
  assert.deepEqual(result.executed.map((entry) => entry.id), ['plan']);
  completeWorkflowStep({ id: 'feature-delivery', stepId: 'design-handoff', projectDir: project, evidence: 'Architecture note identifies boundaries and the testable failure paths.' });
  completeWorkflowStep({ id: 'feature-delivery', stepId: 'approve-plan', projectDir: project, evidence: 'Implementation plan approved after requirement and risk review.' });

  result = runWorkflow({ id: 'feature-delivery', projectDir: project, execute: true });
  assert.deepEqual(result.executed.map((entry) => entry.id), ['compile-packet']);
  assert.ok(existsSync(path.join(packet, 'spec.json')));
  assert.throws(
    () => completeWorkflowStep({ id: 'feature-delivery', stepId: 'verify-packet', projectDir: project, evidence: 'I promise the packet is valid.' }),
    /is executable/
  );

  completeWorkflowStep({ id: 'feature-delivery', stepId: 'implement-handoff', projectDir: project, evidence: 'Implementation evidence and requirement anchors were supplied for review.' });
  result = runWorkflow({ id: 'feature-delivery', projectDir: project, execute: true });
  assert.deepEqual(result.executed.map((entry) => entry.id), ['verify-packet']);
  completeWorkflowStep({ id: 'feature-delivery', stepId: 'review-evidence', projectDir: project, evidence: 'Release reviewer accepted the evidence and recorded residual risk.' });

  const complete = workflowStatus({ id: 'feature-delivery', projectDir: project });
  assert.ok(complete.steps.every((step) => step.status === 'complete'));
  const state = JSON.parse(readFileSync(path.join(project, '.vld', 'workflows', 'feature-delivery.json'), 'utf8'));
  assert.equal(state.steps['verify-packet'].evidence.type, 'command');
});

test('a failing workflow command persists a failure rather than pretending the step ran', (t) => {
  const { project } = fixture(t);
  const missingPacket = path.join(project, 'not-created');
  runWorkflow({ id: 'release-readiness', projectDir: project, context: { packet: missingPacket }, execute: true });
  completeWorkflowStep({ id: 'release-readiness', stepId: 'collect-evidence', projectDir: project, evidence: 'Test and operational evidence collected for the release decision.' });
  const failed = runWorkflow({ id: 'release-readiness', projectDir: project, execute: true });
  assert.deepEqual(failed.executed.map((entry) => [entry.id, entry.status]), [['verify-packet', 'failed']]);
  assert.equal(workflowStatus({ id: 'release-readiness', projectDir: project }).steps.find((step) => step.id === 'verify-packet').status, 'failed');
});
