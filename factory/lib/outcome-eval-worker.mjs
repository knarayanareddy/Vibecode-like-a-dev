#!/usr/bin/env node
/**
 * Isolated functional-oracle worker for outcome evaluation.
 *
 * It is intentionally a separate Node process: workspace source is untrusted and
 * must never be dynamically imported into the evaluator/harness process. The parent
 * invokes this file with a scrubbed environment and, on Node versions that support
 * it, a read-only Permission Model boundary limited to this worker, trusted task
 * fixtures and the workspace under evaluation.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { OUTCOME_TASKS } from '../evals/tasks/index.mjs';

const [taskId, workspaceArg] = process.argv.slice(2);
const workspaceDir = path.resolve(workspaceArg ?? '');
const task = OUTCOME_TASKS.find((entry) => entry.id === taskId);

function reply(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (!task || !workspaceArg) {
  reply({ ok: false, oraclePass: false, oracleError: 'invalid evaluator request', triggeredDefects: [] });
  process.exitCode = 2;
} else {
  const entry = path.join(workspaceDir, 'src', 'index.mjs');
  const triggeredDefects = [];
  let oraclePass = false;
  let oracleError = null;

  try {
    if (!existsSync(entry)) throw new Error('workspace entry is missing');
    // This is the sole intentional import of workspace code. It occurs in the
    // process that is permission-limited and discarded after one evaluation.
    const mod = await import(`${pathToFileURL(entry).href}?outcome-worker=${process.pid}`);
    try {
      await task.oracle(mod, workspaceDir);
      oraclePass = true;
    } catch {
      oracleError = 'functional oracle rejected the workspace';
    }
    for (const probe of task.defectProbes) {
      try {
        await probe.check(mod, workspaceDir);
      } catch {
        triggeredDefects.push(probe.id);
      }
    }
  } catch {
    oracleError = 'workspace module could not be evaluated';
    for (const probe of task.defectProbes) triggeredDefects.push(probe.id);
  }

  reply({ ok: true, oraclePass, oracleError, triggeredDefects });
}
