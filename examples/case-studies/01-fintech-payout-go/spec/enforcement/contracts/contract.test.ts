/**
 * Contract test skeleton.
 *
 * A contract test reads a *recorded* response and asserts this consumer still agrees
 * with it. It is not a mock: a mock you wrote from the documentation tests your
 * assumptions about the documentation, which is how integrations break silently in
 * production while the suite stays green.
 *
 * Record one success and one failure response per external call, store them under
 * tests/fixtures/contracts/, and replace the fixture path below.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, '..', 'tests', 'fixtures', 'contracts', name), 'utf8'));

describe('the vendor contract this build depends on', () => {
  it('parses the recorded success response', () => {
    const recorded = fixture('vendor-success.json');
    // Assert the fields this code actually reads, not the whole payload: a contract
    // covers what you consume, and nothing else.
    expect(recorded).toHaveProperty('id');
    expect(typeof recorded.id).toBe('string');
  });

  it('treats the recorded failure response as a failure, not as data', () => {
    const recorded = fixture('vendor-failure.json');
    // The failure shape is the one that ships broken, because nobody records it.
    expect(recorded).toHaveProperty('error');
  });
});
