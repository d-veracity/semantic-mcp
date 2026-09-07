/**
 * Tests for the shared candidate-scoring primitive (#11 step 3). Proves the
 * machinery on the parameter-name set named in the issue before #6 reuses it on
 * canonical field names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, editDistance, suggestNames, didYouMean } from '../lib/didYouMean.js';

test('normalizeName folds case and separators', () => {
  assert.equal(normalizeName('sector_id'), normalizeName('sectorId'));
  assert.equal(normalizeName('SECTOR-ID'), 'sectorid');
});

test('editDistance is Levenshtein', () => {
  assert.equal(editDistance('sector', 'sector'), 0);
  assert.equal(editDistance('sectorid', 'sector'), 2);
  assert.equal(editDistance('kitten', 'sitting'), 3);
});

test('suggests q for the mistyped query on ofp_search_entities (#11 P3)', () => {
  assert.deepEqual(suggestNames('query', ['q', 'domain', 'limit']), ['q']);
});

test('suggests sector for the mistyped sectorId on ofp_validate (#11 P4)', () => {
  const params = ['entity', 'domain', 'payload', 'sector', 'entityType'];
  assert.deepEqual(suggestNames('sectorId', params), ['sector']);
});

test('stays silent for a genuinely foreign key — no false suggestion', () => {
  assert.deepEqual(suggestNames('__unexpected_param__', ['q', 'domain', 'limit']), []);
});

test('didYouMean formats the sentence, and is empty when nothing is close', () => {
  assert.equal(didYouMean('query', ['q', 'domain', 'limit']), 'Did you mean "q"?');
  assert.equal(didYouMean('__unexpected_param__', ['q']), '');
});
