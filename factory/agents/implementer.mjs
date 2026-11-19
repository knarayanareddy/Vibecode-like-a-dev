#!/usr/bin/env node
/**
 * Sandboxed implementer agent (ADR 0011, roadmap 3.3).
 *
 * A tool-loop coding agent that runs INSIDE the VLD sandbox (started by the
 * `sandboxed-agent` adapter). It can only touch its workspace, only spawn
 * allow-listed commands, and can only reach a model through the brokered
 * model client (cassette replay in tests; VLD_MODEL_BROKER_* egress in live
 * runs). Every tool call is appended to a hash-chained transcript whose
 * digest lands in the agent-run receipt, the delivery candidate, and
 * evidence.jsonl.
 *
 * Tools: read_file, write_file, list_dir, run_tests, run_command, finish.
 * Hard limits: max steps, max tokens, wall-clock, file-write globs.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createModelClient } from '../lib/model-client.mjs';
import {
  computeTranscriptDigest,
  digest,
  transcriptEntryDigest
} from '../lib/agent-transcript.mjs';

const MAX_READ_BYTES = 64 * 1024;
const MAX_WRITE_BYTES = 256 * 1024;
const MAX_RESULT_CHARS = 12_000;
const MAX_LIST_ENTRIES = 400;
const DEFAULT_MAX_STEPS = 40;
const DEFAULT_MAX_TOKENS = 200_000;
const DEFAULT_TIME_LIMIT_MS = 15 * 60_000;
const DEFAULT_TEST_TIMEOUT_MS = 60_000;

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 file from the workspace. Returns bounded content.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative file path' } },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Write a UTF-8 file inside the package write globs. Creates parent directories.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path' },
        content: { type: 'string', description: 'Full file content' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'list_dir',
    description: 'List a workspace directory (names and sizes, bounded).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative directory (default .)' } }
    }
  },
  {
    name: 'run_tests',
    description: 'Run the package test command. Returns exit code and output tail.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'run_command',
    description: 'Run one allow-listed command. Rejected unless the command matches the allow-list.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Exact command string, e.g. "node --check src/todo.mjs"' }
      },
      required: ['command']
    }
  },
  {
    name: 'finish',
    description: 'End the run. success=true when the work is complete and tests pass.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What was changed and why' },
        success: { type: 'boolean' }
      },
      required: ['summary', 'success']
    }
  }
];

function parseArgs(argv) {
  const args = { allowCmds: [], writeGlobs: null, maxSteps: DEFAULT_MAX_STEPS, maxTokens: DEFAULT_MAX_TOKENS, timeLimitMs: DEFAULT_TIME_LIMIT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      i += 1;
      return argv[i];
    };
    if (flag === '--model') args.model = next();
    else if (flag === '--workspace') args.workspace = next();
    else if (flag === '--packet') args.packet = next();
    else if (flag === '--task-file') args.taskFile = next();
    else if (flag === '--write-globs') args.writeGlobs = next();
    else if (flag === '--allow-cmd') args.allowCmds.push(next());
    else if (flag === '--test-cmd') args.testCmd = next();
    else if (flag === '--max-steps') args.maxSteps = Number(next());
    else if (flag === '--max-tokens') args.maxTokens = Number(next());
    else if (flag === '--time-limit-ms') args.timeLimitMs = Number(next());
    else if (flag === '--repair-brief') args.repairBrief = next();
  }
  return args;
}

/** Minimal glob matcher supporting `**` and `*` segments (write-glob gate). */
export function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${body}$`);
}

function matchesAnyGlob(relPath, globs) {
  const normalized = relPath.split(path.sep).join('/');
  return globs.some((pattern) => globToRegExp(pattern).test(normalized));
}

function resolveWorkspacePath(workspace, rel) {
  const target = path.resolve(workspace, String(rel ?? ''));
  const root = path.resolve(workspace);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`path escapes the workspace: ${rel}`);
  }
  return target;
}

function truncate(text, limit = MAX_RESULT_CHARS) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}\n[truncated]` : value;
}

/**
 * Strip wall-clock nondeterminism from test/tool output so a recorded cassette
 * conversation replays byte-identically (the request digest covers messages).
 */
export function normalizeToolOutput(text) {
  return String(text ?? '')
    .replace(/^\(node:\d+\) SecurityWarning:[^\n]*\n?/gm, '')
    .replace(/^\(node:\d+\) \[MODULE_TYPELESS_PACKAGE_JSON\][^\n]*\n?/gm, '')
    .replace(/^Reparsing as ES module because module syntax was detected\.[^\n]*\n?/gm, '')
    .replace(/^To eliminate this warning, add "type": "module" to [^\n]*\n?/gm, '')
    .replace(/^\(Use `node --trace-warnings[^\n]*\n?/gm, '')
    .replace(/\(node:\d+\)/g, '(node:0)')
    .replace(/duration_ms:?\s+[0-9.]+/g, 'duration_ms: 0')
    .replace(/^# (?:start|end|duration)[^\n]*\n?/gm, '')
    // TAP YAML diagnostics vary across Node releases (e.g. `type: 'test'`
    // appeared in the reporter after 22.0) and absolute location paths vary
    // across machines; neither belongs in a replay-stable conversation.
    .replace(/^[ \t]+type: '[^'\n]+'[ \t]*\n?/gm, '')
    .replace(/location: '[^'\n]*[/\\]([^/'\n]+)'/g, "location: '$1'")
    .replace(/\r\n/g, '\n');
}

function runChild(executable, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    // Strip test-runner injection vars: an inherited NODE_TEST_CONTEXT switches
    // `node --test` children to the v8 event protocol with nondeterministic
    // binary output, and Node's permission model propagates itself through
    // NODE_OPTIONS (with PID-tagged warnings). A declared test command runs as
    // a plain, trusted process — its output must stay deterministic.
    const childEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('NODE_TEST')) continue;
      if (key === 'NODE_OPTIONS' || key === 'NODE_CHANNEL_FD' || key === 'NODE_UNIQUE_ID') continue;
      childEnv[key] = value;
    }
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
    let out = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finish({ exitCode: null, output: `${out}\n[test command timed out after ${timeoutMs}ms]` });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { out += chunk; });
    child.stderr?.on('data', (chunk) => { out += chunk; });
    child.once('error', (error) => finish({ exitCode: null, output: `${out}\n[spawn failed: ${error.message}]` }));
    child.once('close', (exitCode) => finish({ exitCode, output: out }));
  });
}

function splitCommand(command) {
  const tokens = String(command).match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  return tokens.map((token) => token.replace(/^"(.*)"$/, '$1'));
}

function isAllowedCommand(command, allowCmds) {
  const trimmed = String(command).trim();
  const tokens = splitCommand(trimmed);
  if (!tokens.length) return false;
  return allowCmds.some((allowed) => {
    const allowedTokens = splitCommand(String(allowed).trim());
    if (!allowedTokens.length) return false;
    if (allowedTokens.length === 1) return tokens[0] === allowedTokens[0] || trimmed === allowedTokens[0];
    return trimmed === String(allowed).trim();
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = path.resolve(args.workspace ?? '.');
  const env = process.env;
  const runId = env.VLD_RUN_ID || `local-${Date.now()}`;
  const requirementIds = String(env.VLD_REQUIREMENT_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const writeGlobs = String(args.writeGlobs ?? env.VLD_WRITE_GLOBS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!writeGlobs.length) writeGlobs.push('**');
  const allowCmds = args.allowCmds.length
    ? args.allowCmds
    : String(env.VLD_ALLOW_COMMANDS ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  let testCmd = null;
  const rawTestCmd = args.testCmd ?? env.VLD_TEST_COMMAND ?? null;
  if (rawTestCmd) {
    try {
      const parsed = JSON.parse(rawTestCmd);
      testCmd = {
        executable: parsed.executable,
        args: Array.isArray(parsed.args) ? parsed.args : [],
        timeoutMs: Number(parsed.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS)
      };
    } catch {
      testCmd = null;
    }
  }

  const transcriptDir = path.join(workspace, '.vld', 'agent-transcripts');
  mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = path.join(transcriptDir, `${runId}.jsonl`);
  const summaryPath = path.join(transcriptDir, `${runId}.summary.json`);
  const entries = [];
  let seq = 0;

  const appendEntry = (entry) => {
    seq += 1;
    const full = {
      seq,
      at: new Date().toISOString(),
      type: entry.type ?? 'tool',
      tool: entry.tool ?? '',
      argsDigest: entry.argsDigest ?? '',
      resultDigest: entry.resultDigest ?? '',
      ok: entry.ok !== false,
      ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {})
    };
    full.entryDigest = transcriptEntryDigest(full);
    entries.push(full);
    writeFileSync(transcriptPath, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
  };

  const writeSummary = (summary) => {
    const transcriptDigest = computeTranscriptDigest(entries);
    const record = { runId, transcriptDigest, steps: seq, ...summary };
    appendEntry({ type: 'summary', tool: '', ok: record.ok !== false });
    // appendEntry hashed a summary-shaped entry; replace it with the real summary line.
    entries[entries.length - 1] = {
      type: 'summary',
      runId,
      transcriptDigest,
      steps: seq,
      ...summary
    };
    writeFileSync(
      transcriptPath,
      `${entries.map((e) => (e.type === 'summary' ? JSON.stringify(e) : JSON.stringify(e))).join('\n')}\n`,
      'utf8'
    );
    writeFileSync(summaryPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return transcriptDigest;
  };

  // ---- Context: task brief + requirement subset + stack conventions ----------
  const taskFile = args.repairBrief ?? env.VLD_REPAIR_BRIEF ?? args.taskFile ?? null;
  let taskText = '';
  if (taskFile && existsSync(path.resolve(workspace, taskFile))) {
    taskText = readFileSync(path.resolve(workspace, taskFile), 'utf8').slice(0, 20_000);
  } else if (taskFile && existsSync(taskFile)) {
    taskText = readFileSync(taskFile, 'utf8').slice(0, 20_000);
  }
  if (!taskText && existsSync(path.join(workspace, 'TASK.md'))) {
    taskText = readFileSync(path.join(workspace, 'TASK.md'), 'utf8').slice(0, 20_000);
  }

  const packetDir = args.packet ? path.resolve(workspace, args.packet) : path.join(workspace, 'specs');
  const packetSpecPath = path.join(packetDir, 'spec.json');
  let requirementLines = [];
  if (existsSync(packetSpecPath)) {
    const packetSpec = JSON.parse(readFileSync(packetSpecPath, 'utf8'));
    const all = Array.isArray(packetSpec.requirements) ? packetSpec.requirements : [];
    const subset = requirementIds.length ? all.filter((r) => requirementIds.includes(r.id)) : all;
    requirementLines = subset.map((r) => `- ${r.id} (${r.verify ?? 'unknown'}): ${r.statement ?? r.description ?? ''}`);
    if (!requirementLines.length) {
      requirementLines = subset.map((r) => `- ${r.id}`);
    }
  }
  let stackConventions = '';
  for (const candidate of ['AGENTS.md', 'docs/AGENTS.md', 'CONVENTIONS.md']) {
    const p = path.join(packetDir, candidate);
    if (existsSync(p)) {
      stackConventions = readFileSync(p, 'utf8').slice(0, 4_000);
      break;
    }
  }

  const systemPrompt = [
    'You are the VLD implementer agent working inside a sandboxed workspace.',
    'Your job: implement the assigned requirements so the package test command passes.',
    '',
    'Hard rules:',
    `1. Only write files matching the write globs: ${writeGlobs.join(', ')}. Writes outside these globs are rejected.`,
    '2. run_command only works for allow-listed commands; run_tests runs the declared test command.',
    '3. Never open network connections; model access is brokered for you.',
    '4. When the work is done and tests pass, call finish with success=true. Do not stop without calling finish.',
    '',
    `Tools: ${TOOLS.map((t) => t.name).join(', ')}.`
  ].join('\n');

  const userContext = [
    '## Task',
    taskText || '(no task brief provided; implement the requirements below)',
    '',
    '## Requirements in this work package',
    ...(requirementLines.length ? requirementLines : ['- (see packet spec.json)']),
    ...(stackConventions ? ['', '## Stack conventions', stackConventions] : []),
    '',
    `Write globs: ${writeGlobs.join(', ')}`,
    `Allow-listed commands: ${allowCmds.length ? allowCmds.join(' | ') : '(none)'}`,
    `Test command: ${testCmd ? `${path.basename(testCmd.executable)} ${testCmd.args.join(' ')}` : '(none declared)'}`
  ].join('\n');

  // ---- Model client (broker env or cassette supplied by the adapter) --------
  const modelSpec = String(args.model ?? env.VLD_MODEL_SPEC ?? 'command:shim');
  const separator = modelSpec.indexOf(':');
  const provider = separator > 0 ? modelSpec.slice(0, separator) : 'command';
  const rest = separator > 0 ? modelSpec.slice(separator + 1) : 'shim';
  const secondSep = rest.indexOf(':');
  const model = secondSep > 0 ? rest.slice(0, secondSep) : rest;
  const baseUrl = secondSep > 0 ? rest.slice(secondSep + 1) : (env.VLD_MODEL_BASE_URL ?? null);
  const client = createModelClient({
    provider,
    model,
    ...(env.VLD_MODEL_TOKEN_ENV ? { tokenEnv: env.VLD_MODEL_TOKEN_ENV } : {}),
    baseUrl,
    cassetteDir: env.VLD_MODEL_CASSETTE_DIR ?? null,
    cassetteMode: env.VLD_MODEL_CASSETTE_MODE ?? null,
    command: env.VLD_MODEL_COMMAND ?? null,
    budget: {
      maxTotalTokens: args.maxTokens,
      ...(env.VLD_MODEL_MAX_COST_USD ? { maxCostUsd: Number(env.VLD_MODEL_MAX_COST_USD) } : {})
    }
  });

  const messages = [{ role: 'user', content: userContext }];
  const started = Date.now();
  let finishResult = null;
  let limitError = null;

  const executeTool = async (toolName, input) => {
    const startedTool = Date.now();
    let result;
    let ok = true;
    try {
      if (toolName === 'read_file') {
        const target = resolveWorkspacePath(workspace, input.path);
        if (!existsSync(target)) result = { error: `no such file: ${input.path}` };
        else result = { content: truncate(readFileSync(target, 'utf8'), MAX_READ_BYTES) };
      } else if (toolName === 'write_file') {
        const rel = String(input.path ?? '');
        const target = resolveWorkspacePath(workspace, rel);
        if (!matchesAnyGlob(rel, writeGlobs)) {
          ok = false;
          result = { error: `write denied: ${rel} does not match write globs (${writeGlobs.join(', ')})` };
        } else if (String(input.content ?? '').length > MAX_WRITE_BYTES) {
          ok = false;
          result = { error: `write denied: content exceeds ${MAX_WRITE_BYTES} bytes` };
        } else {
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, String(input.content ?? ''), 'utf8');
          result = { wrote: rel, bytes: Buffer.byteLength(String(input.content ?? ''), 'utf8') };
        }
      } else if (toolName === 'list_dir') {
        const target = resolveWorkspacePath(workspace, input.path ?? '.');
        const { readdirSync, statSync } = await import('node:fs');
        const names = readdirSync(target).slice(0, MAX_LIST_ENTRIES);
        result = {
          entries: names.map((name) => {
            try {
              const st = statSync(path.join(target, name));
              return { name, size: st.size, dir: st.isDirectory() };
            } catch {
              return { name };
            }
          })
        };
      } else if (toolName === 'run_tests') {
        if (!testCmd) {
          ok = false;
          result = { error: 'no test command declared for this package' };
        } else {
          const run = await runChild(testCmd.executable, testCmd.args, { cwd: workspace, timeoutMs: testCmd.timeoutMs });
          result = { exitCode: run.exitCode, output: truncate(normalizeToolOutput(run.output), 8_000) };
          if (run.exitCode !== 0) ok = true; // failing tests are a legitimate tool result
        }
      } else if (toolName === 'run_command') {
        const command = String(input.command ?? '');
        if (!isAllowedCommand(command, allowCmds)) {
          ok = false;
          result = { error: `command not allow-listed: ${command}` };
        } else {
          const tokens = splitCommand(command);
          const run = await runChild(tokens[0], tokens.slice(1), { cwd: workspace, timeoutMs: DEFAULT_TEST_TIMEOUT_MS });
          result = { exitCode: run.exitCode, output: truncate(normalizeToolOutput(run.output), 8_000) };
        }
      } else if (toolName === 'finish') {
        finishResult = { summary: String(input.summary ?? ''), success: input.success === true };
        result = { ok: finishResult.success };
      } else {
        ok = false;
        result = { error: `unknown tool: ${toolName}` };
      }
    } catch (error) {
      ok = false;
      result = { error: String(error.message ?? error) };
    }
    const durationMs = Date.now() - startedTool;
    appendEntry({
      type: 'tool',
      tool: toolName,
      argsDigest: digest({ tool: toolName, input: safeArgs(toolName, input) }),
      resultDigest: digest(result),
      ok,
      durationMs
    });
    return { result, ok, durationMs };
  };

  function safeArgs(toolName, input) {
    if (toolName === 'write_file') return { path: input.path, bytes: String(input.content ?? '').length };
    return input ?? {};
  }

  // ---- Tool loop -----------------------------------------------------------
  const requestDigests = [];
  try {
    for (let step = 1; step <= args.maxSteps; step += 1) {
      if (Date.now() - started > args.timeLimitMs) {
        limitError = `wall-clock limit exceeded (${args.timeLimitMs}ms)`;
        break;
      }
      const response = await client.complete({
        system: systemPrompt,
        messages,
        tools: TOOLS,
        maxTokens: 2048,
        temperature: 0
      });
      if (response.requestDigest) requestDigests.push(response.requestDigest);
      const usage = client.getUsageSummary();
      const totalTokens = Number(usage.totals?.totalTokens ?? 0);
      if (totalTokens > args.maxTokens) {
        limitError = `token limit exceeded (${totalTokens} > ${args.maxTokens})`;
        break;
      }
      const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
      if (!toolCalls.length) {
        messages.push({ role: 'user', content: 'Continue, or call finish when the work is complete and tests pass.' });
        continue;
      }
      messages.push({ role: 'assistant', content: response.text || '', toolCalls });
      for (const call of toolCalls) {
        const { result, ok } = await executeTool(call.name, call.input ?? {});
        messages.push({
          role: 'tool',
          toolCallId: call.id ?? `call_${seq}`,
          content: `${ok ? '' : '[tool error] '}${JSON.stringify(result)}`
        });
        if (call.name === 'finish') break;
      }
      if (finishResult) break;
    }
    if (!finishResult && !limitError) limitError = `step limit exceeded (${args.maxSteps})`;
  } catch (error) {
    limitError = `model/tool failure: ${String(error.message ?? error)}${error?.stack ? ` | ${String(error.stack).split('\n').slice(1, 4).join(' <- ').trim()}` : ''}`;
  }

  const usage = client.getUsageSummary();
  const totals = usage.totals ?? {};
  const ok = Boolean(finishResult?.success) && !limitError;
  writeSummary({
    ok,
    finish: finishResult,
    limitError,
    // Roadmap 4.3: verifiable provenance — the prompt hash covers every model
    // request of this run in order; requestDigests make it re-computable.
    promptHash: requestDigests.length > 0 ? digest(requestDigests) : null,
    requestDigests: requestDigests.slice(0, 64),
    usage: {
      inputTokens: Number(totals.inputTokens ?? 0),
      outputTokens: Number(totals.outputTokens ?? 0),
      totalTokens: Number(totals.totalTokens ?? 0),
      costUsd: Number(totals.costUsd ?? 0)
    },
    durationMs: Date.now() - started
  });
  if (ok) {
    process.stdout.write(`implementer finished: ${finishResult.summary}\n`);
    process.exitCode = 0;
  } else {
    process.stderr.write(`implementer ${limitError ? `aborted: ${limitError}` : `finished with success=false: ${finishResult?.summary ?? ''}`}\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`implementer crashed: ${String(error?.stack ?? error)}\n`);
  process.exitCode = 3;
});
