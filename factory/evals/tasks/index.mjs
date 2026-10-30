import { BROWNFIELD_TASKS } from './brownfield.mjs';
import { BUGFIX_TASKS } from './bugfix.mjs';
import { GREENFIELD_TASKS } from './greenfield.mjs';
import { REFACTOR_TASKS } from './refactor.mjs';
import { SYSTEMS_TASKS } from './systems.mjs';

export const OUTCOME_TASKS = [
  ...GREENFIELD_TASKS,
  ...BROWNFIELD_TASKS,
  ...BUGFIX_TASKS,
  ...REFACTOR_TASKS,
  ...SYSTEMS_TASKS
];

export const OUTCOME_ARMS = ['no-spec', 'generic-spec', 'vld-packet'];

export function validateOutcomeTasks(tasks = OUTCOME_TASKS) {
  const errors = [];
  const seen = new Set();

  for (const task of tasks) {
    if (!task.id || seen.has(task.id)) errors.push(`duplicate or missing task id: ${task.id}`);
    seen.add(task.id);
    if (!['greenfield', 'brownfield', 'bugfix', 'refactor', 'systems'].includes(task.category)) {
      errors.push(`${task.id}: invalid category "${task.category}"`);
    }
    if (!task.ticket || task.ticket.length < 60) errors.push(`${task.id}: ticket prompt too thin`);
    if (!task.profile?.name || !task.profile?.idea) errors.push(`${task.id}: missing profile`);
    if (!task.starter || !task.naive || !task.reference || !task.semanticDrift) {
      errors.push(`${task.id}: missing one of starter/naive/reference/semanticDrift file maps`);
    }
    if (typeof task.oracle !== 'function') errors.push(`${task.id}: missing oracle function`);
    if (!Array.isArray(task.defectProbes) || task.defectProbes.length === 0) {
      errors.push(`${task.id}: needs at least one defectProbe`);
    }
  }

  return errors;
}
