/**
 * Release metadata authority.
 *
 * Package metadata is deliberately read as ordinary JSON rather than imported as
 * an ESM JSON module: Node 22.0 prints an ExperimentalWarning for JSON imports,
 * which would pollute clean machine-readable CLI output.
 */
import { readFileSync } from 'node:fs';

export const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
).version;
