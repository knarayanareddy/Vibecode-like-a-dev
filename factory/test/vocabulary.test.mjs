/**
 * The vocabulary is load-bearing: every derived sentence in a packet uses it, so a
 * wrong noun is a wrong sentence in eight documents at once. The first version of
 * this extractor produced "a change to how a yesterday behaves", which is the exact
 * failure mode these tests exist to prevent.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { articleFor, ideaNouns, pluralOf, singularOf, vocabularyFor } from '../lib/emit/vocabulary.mjs';
import { ROOT } from '../lib/indexer.mjs';

/**
 * Words that can never be the subject of a product sentence. This list is
 * deliberately short: it is a tripwire, not a lexicon.
 */
const FORBIDDEN = [
  'yesterday',
  'today',
  'tomorrow',
  'nightly',
  'scheduled',
  'duplicating',
  'instantly',
  'highest',
  'internal',
  'multiple',
  'percent'
];

function profiles() {
  const ideas = readdirSync(path.join(ROOT, 'examples', 'ideas'))
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(path.join(ROOT, 'examples', 'ideas', file), 'utf8')));

  const adversarial = JSON.parse(
    readFileSync(path.join(ROOT, 'examples', 'ideas', 'adversarial', 'cases.json'), 'utf8')
  ).cases
    .filter((testCase) => testCase.expect === 'packet')
    .map((testCase) => testCase.profile);

  const retro = JSON.parse(readFileSync(path.join(ROOT, 'examples', 'retro-board', 'profile.json'), 'utf8'));
  return [...ideas, ...adversarial, retro];
}

test('a vocabulary never yields a word that cannot be the subject of a sentence', () => {
  for (const profile of profiles()) {
    const vocab = vocabularyFor(profile);
    assert.ok(vocab.primary.length > 1, `${profile.name}: no primary noun`);
    assert.ok(vocab.secondary.length > 1, `${profile.name}: no secondary noun`);
    assert.ok(!FORBIDDEN.includes(vocab.primary), `${profile.name}: primary is "${vocab.primary}"`);
    assert.ok(!FORBIDDEN.includes(vocab.secondary), `${profile.name}: secondary is "${vocab.secondary}"`);
  }
});

test('a vocabulary is always usable in a sentence: article matches, no empty noun', () => {
  for (const profile of profiles()) {
    const vocab = vocabularyFor(profile);
    assert.match(vocab.aPrimary, /^(a|an) [a-z0-9-]+$/, `${profile.name}: "${vocab.aPrimary}"`);
    assert.equal(vocab.aPrimary.split(' ')[0], articleFor(vocab.primary));
    // "an" before a consonant is as wrong as "a" before a vowel.
    assert.equal(/^an/.test(vocab.aPrimary), /^[aeiou]/.test(vocab.primary), `${profile.name}: "${vocab.aPrimary}"`);
  }
});

test('a one-word idea with no nameable noun falls back to its kind instead of guessing', () => {
  const emoji = vocabularyFor({ name: 'emoji', idea: '🎉🎉🎉', kind: 'web-app', traits: [], risks: {} });
  assert.equal(emoji.source, 'kind');
  assert.ok(emoji.primary.length > 2);

  const twoWords = vocabularyFor({ name: 'inventory', idea: 'Inventory sync.', kind: 'data-pipeline', traits: [], risks: {} });
  assert.equal(twoWords.primary, 'inventory', 'the only noun in a two-word idea is still a noun');
});

test('the tense adverbs that broke v1 of this extractor are not nouns', () => {
  const vocab = vocabularyFor({
    name: 'nightly',
    idea: "A nightly job that copies yesterday's orders into a reporting table and emails a summary of failures.",
    kind: 'data-pipeline',
    traits: [],
    risks: {}
  });
  assert.notEqual(vocab.primary, 'yesterday');
  assert.notEqual(vocab.primary, 'nightly');
  assert.ok(vocab.candidates.some((candidate) => candidate.word === 'order'), JSON.stringify(vocab.candidates));
});

test('singular and plural round-trip on the words ideas actually use, including silent-e -ses/-ces/-zes', () => {
  const cases = {
    bookings: 'booking',
    entries: 'entry',
    flags: 'flag',
    statuses: 'status',
    addresses: 'address',
    photos: 'photo',
    expenses: 'expense',
    leases: 'lease',
    invoices: 'invoice',
    exercises: 'exercise',
    warehouses: 'warehouse',
    cases: 'case'
  };
  for (const [plural, singular] of Object.entries(cases)) {
    assert.equal(singularOf(plural), singular, plural);
    assert.equal(pluralOf(singular), plural, singular);
  }
});

test('agentive -ant/-ent nouns and third-person verbs after them do not produce mangled stems like "exercis"', () => {
  const vocab = vocabularyFor({
    name: 'trialbridge-reimburse',
    idea:
      'A multi-tenant clinical trial stipend and travel reimbursement platform for pharmaceutical sponsors, hospital study coordinators, and enrolled trial participants replacing manual spreadsheets and wire transfers. Coordinators capture mileage, hotel, and meal receipts—including offline on clinic tablets—while an AI extraction pipeline parses receipt line items and flags duplicate or out-of-protocol claims without ever sending patient names or IBANs to external model providers. Approved claims debit pre-funded sponsor escrow balances in integer minor currency units. When a participant exercises GDPR right-to-erasure or withdraws consent, personal identifiers and uploaded receipt images must be crypto-shredded within 30 days.',
    kind: 'web-app',
    traits: ['auth', 'payments', 'offline'],
    risks: { pii: true, payments: true, regulated: true, multiTenant: true }
  });

  assert.notEqual(vocab.primary, 'exercis');
  assert.notEqual(vocab.secondary, 'exercis');
  assert.notEqual(vocab.primary, 'exercise');
  assert.notEqual(vocab.secondary, 'exercise');
  assert.ok(!vocab.candidates.some((c) => c.word === 'exercis' || c.word === 'exercise'), JSON.stringify(vocab.candidates));
  assert.ok(vocab.candidates.some((c) => c.word === 'participant'), 'participant (-ant) must not be vetoed as an adjective');
  assert.equal(vocab.secondary, 'participant', 'actor role lands in secondary');
  assert.ok(
    ['claim', 'reimbursement', 'trial', 'receipt', 'stipend'].includes(vocab.primary),
    `expected domain object in primary (not a 1x hyphenated anti-pattern), got "${vocab.primary}"`
  );
});

test('idea nouns are candidates with counts, not conclusions', () => {
  const nouns = ideaNouns({
    name: 'x',
    idea: 'A booking service for clinics. Patients book appointments with a therapist. A booking never double-books.',
    kind: 'api',
    traits: [],
    risks: {}
  });
  assert.ok(nouns.length > 0);
  for (const noun of nouns) {
    assert.equal(typeof noun.word, 'string');
    assert.equal(typeof noun.count, 'number');
  }
});

test('industry -or/-er actors like aggregator and dispatcher land in secondary while primary keeps the domain object', () => {
  const vocab = vocabularyFor({
    name: 'gridpulse-dispatch',
    idea:
      'A multi-tenant virtual power plant dispatch, live battery telemetry, and wholesale revenue-settlement platform for commercial fleet operators, solar-plus-storage site hosts, and grid aggregators replacing manual curtailment spreadsheets. Every aggregator tenant is isolated from competing aggregators, and regional dispatch operators may only command batteries assigned to their grid zone. Cleared market settlements credit host revenue-share accounts and trigger ACH payouts where webhook retries or partial settlement reversals never create duplicate disbursements.',
    kind: 'web-app',
    traits: ['auth', 'payments', 'realtime', 'offline'],
    risks: { pii: true, payments: true, regulated: true, multiTenant: true }
  });

  assert.notEqual(vocab.primary, 'aggregator', 'aggregator is an actor/tenant role, not the primary domain object');
  assert.ok(['settlement', 'curtailment', 'battery'].includes(vocab.primary), `unexpected primary: "${vocab.primary}"`);
  assert.ok(['aggregator', 'operator', 'host'].includes(vocab.secondary), `unexpected secondary: "${vocab.secondary}"`);
});

