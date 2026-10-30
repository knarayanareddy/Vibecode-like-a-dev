/**
 * Executable gates.
 *
 * A gate written as a sentence is a hope. This module turns each gate in the plan
 * into files a repository can actually run:
 *
 *   enforcement/gates.mjs     one check per gate, generated from factory/gates/gates.json
 *   enforcement/README.md     the gate -> mechanism -> command table
 *   enforcement/<tool>...     the config fragment for gates whose real check is a
 *                             linter, a policy engine or a mutation runner
 *
 * Two rules keep this honest:
 *
 *   1. Every gate gets a mechanism, including the ones no machine can check. Those
 *      get an attestation file with required fields, because "we do it" is not a
 *      mechanism — a dated record with a name on it is.
 *   2. Every mechanism states what it does *not* prove. A check that passes on a
 *      repository that ignores the gate is worse than no check at all.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './indexer.mjs';

const REGISTRY_PATH = path.join(ROOT, 'factory', 'gates', 'gates.json');
const TEMPLATE_PATH = path.join(ROOT, 'factory', 'templates', 'gate-runner.mjs');

export const RUNNER = 'enforcement/gates.mjs';
export const RUNNER_COMMAND = 'node enforcement/gates.mjs';

let cached = null;

export function loadGateRegistry() {
  if (!cached) cached = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  return cached;
}

/** The mechanism for one gate, or null when the registry has no entry for it. */
export function gateMechanism(gateId) {
  const gate = loadGateRegistry().gates[gateId];
  if (!gate) return null;
  return {
    id: gateId,
    check: gate.check,
    how: gate.how ?? '',
    mechanism: gate.mechanism ?? '',
    files: (gate.files ?? []).map((file) => file.path),
    command: RUNNER_COMMAND
  };
}

/** Gates in the plan that the registry does not cover — a defect, not a gap. */
export function unmappedGates(gates = []) {
  return gates.map((gate) => (typeof gate === 'string' ? gate : gate.id)).filter((id) => !gateMechanism(id));
}

/**
 * The enforcement files for a packet.
 *
 * Only the gates this packet actually has are written, so a tier-1 project is not
 * handed a mutation-testing config it will never open.
 */
export function enforcementFiles(plan) {
  const registry = loadGateRegistry().gates;
  const ids = (plan.gates ?? []).map((gate) => (typeof gate === 'string' ? gate : gate.id));
  const rules = Object.fromEntries(
    ids
      .filter((id) => registry[id])
      .map((id) => [id, { check: registry[id].check, how: registry[id].how, mechanism: registry[id].mechanism }])
  );

  const files = new Map();

  // The runner is generated with this packet's rules embedded: one file, no lookup at
  // run time, and a diff in the rules is a diff a reviewer can see.
  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  files.set(RUNNER, template.replace('__RULES__', JSON.stringify(rules, null, 2)));

  // Config fragments for the gates whose real check belongs to another tool.
  for (const id of ids) {
    for (const file of registry[id]?.files ?? []) {
      const source = path.join(ROOT, 'factory', 'gates', file.template);
      if (existsSync(source)) files.set(file.path, readFileSync(source, 'utf8'));
    }
  }

  files.set('enforcement/README.md', readme(plan, ids, rules, registry));
  return files;
}

function readme(plan, ids, rules, registry) {
  const rows = ids.map((id) => {
    const gate = (plan.gates ?? []).find((entry) => (typeof entry === 'string' ? entry : entry.id) === id);
    const statement = typeof gate === 'string' ? '' : gate?.statement ?? '';
    const mechanism = rules[id]?.mechanism || 'No mechanism registered. This is a defect in the compiler, not a gap in your project.';
    const extra = (registry[id]?.files ?? []).map((file) => `\`${file.path}\``).join(', ');
    return `| \`${id}\` | ${statement || '—'} | \`${RUNNER_COMMAND}\`${extra ? ` + ${extra}` : ''} | ${mechanism} |`;
  });

  return `# Gate enforcement

Every gate in \`spec.json\` has exactly one command that checks it. This directory is
generated; re-run \`vld compile … --force\` after changing the profile rather than
editing it by hand.

\`\`\`bash
node enforcement/gates.mjs            # check this repository
node enforcement/gates.mjs --strict   # pending gates fail too: use this in release CI
node enforcement/gates.mjs --json     # feed it to something else
\`\`\`

\`enforcement/gates.mjs\` has no dependencies, so it runs anywhere Node runs and can be
committed alongside the spec. It checks structure — files, commands, anchors, record
fields — because that is what a repository can prove about itself. It is not proof
that the gate is *met*: each row says what the mechanism cannot see, and those gaps
are where review still matters.

| Gate | What it asks for | How it is checked | What this mechanism does not prove |
| --- | --- | --- | --- |
${rows.join('\n')}

## Gates that need a person

An attestation gate (\`enforcement/<gate>.md\`) is not a checkbox. It is a file with
required fields — a date, a name, an outcome — because the alternative is a claim with
no record, which is indistinguishable from not doing it. Fill it in when the thing
happens; the runner rejects a file with the fields missing.
`;
}
