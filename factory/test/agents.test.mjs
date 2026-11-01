import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { agentStatus, installAgent, listAdapters } from '../lib/agents.mjs';
import { enableModules } from '../lib/modules.mjs';

test('agent adapter catalogue validates and generated skills are version-locked', (t) => {
  const project = mkdtempSync(path.join(os.tmpdir(), 'vld-agent-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  assert.deepEqual(listAdapters().errors, []);
  enableModules({ projectDir: project, ids: 'product' });

  const installed = installAgent({ id: 'codex', projectDir: project });
  assert.equal(installed.files.length, 2);
  const discovery = path.join(project, '.agents', 'skills', 'vld-discovery', 'SKILL.md');
  assert.ok(existsSync(discovery));
  assert.match(readFileSync(discovery, 'utf8'), /VLD-governed repository/);
  assert.match(readFileSync(discovery, 'utf8'), /`product`/);
  assert.equal(agentStatus(project, 'codex').ok, true);

  writeFileSync(discovery, '# local modification\n');
  const drifted = agentStatus(project, 'codex');
  assert.equal(drifted.ok, false);
  assert.match(drifted.adapters[0].drift.join('\n'), /modified outside vld/);
  assert.throws(() => installAgent({ id: 'codex', projectDir: project }), /refusing to overwrite/);

  const refreshed = installAgent({ id: 'codex', projectDir: project, force: true });
  assert.ok(refreshed.files.some((file) => file.changed));
  assert.equal(agentStatus(project, 'codex').ok, true);

  // Adapter state is untrusted project data too: it must not turn a status check
  // into a read outside the project directory.
  const stateFile = path.join(project, '.vld', 'agents', 'codex.json');
  const badState = JSON.parse(readFileSync(stateFile, 'utf8'));
  badState.files[0].path = '../outside.txt';
  writeFileSync(stateFile, JSON.stringify(badState));
  assert.match(agentStatus(project, 'codex').adapters[0].drift.join('\n'), /invalid managed file entry|escapes the project/);
  installAgent({ id: 'codex', projectDir: project, force: true });

  // An adapter records the enabled module set in its generated guidance. Adding a
  // module later is not silently treated as up to date: status forces a refresh.
  enableModules({ projectDir: project, ids: 'qa' });
  assert.match(agentStatus(project, 'codex').adapters[0].drift.join('\n'), /module set changed/);
});

test('Claude Code adapter writes commands in its own target without creating an agent process', (t) => {
  const project = mkdtempSync(path.join(os.tmpdir(), 'vld-agent-claude-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));

  const installed = installAgent({ id: 'claude-code', projectDir: project });
  assert.deepEqual(installed.files.map((file) => file.path), [
    '.claude/commands/vld-discovery.md',
    '.claude/commands/vld-feature-delivery.md'
  ]);
  const command = readFileSync(path.join(project, '.claude', 'commands', 'vld-feature-delivery.md'), 'utf8');
  assert.match(command, /^---/);
  assert.match(command, /never self-approves a release/);
  assert.equal(existsSync(path.join(project, '.agents')), false, 'a Claude adapter does not leave unrelated tool files');
});


test('agent installation rejects symlinked handoff and state destinations without writing outside the project', (t) => {
  const project = mkdtempSync(path.join(os.tmpdir(), 'vld-agent-links-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'vld-agent-outside-'));
  t.after(() => { rmSync(project, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });

  symlinkSync(outside, path.join(project, '.agents'), 'dir');
  assert.throws(
    () => installAgent({ id: 'codex', projectDir: project }),
    (error) => error.code === 'UNSAFE_MANAGED_PATH'
  );
  assert.equal(existsSync(path.join(outside, 'skills', 'vld-discovery', 'SKILL.md')), false);

  rmSync(path.join(project, '.agents'));
  rmSync(path.join(project, '.vld'), { recursive: true, force: true });
  symlinkSync(outside, path.join(project, '.vld'), 'dir');
  assert.throws(
    () => installAgent({ id: 'codex', projectDir: project }),
    (error) => error.code === 'UNSAFE_MANAGED_PATH'
  );
  assert.equal(existsSync(path.join(outside, 'agents', 'codex.json')), false);

  rmSync(path.join(project, '.vld'), { recursive: true, force: true });
  mkdirSync(path.join(project, '.vld', 'agents'), { recursive: true });
  symlinkSync(path.join(outside, 'state.json'), path.join(project, '.vld', 'agents', 'codex.json'));
  assert.throws(
    () => installAgent({ id: 'codex', projectDir: project }),
    (error) => error.code === 'UNSAFE_MANAGED_PATH'
  );
  assert.equal(existsSync(path.join(outside, 'state.json')), false);
});
