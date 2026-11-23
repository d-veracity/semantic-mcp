/**
 * Open Footprint client method tests (node --test, no network).
 *
 * These lock the URL each method builds, because the two that matter are easy
 * to get subtly wrong: an entity fetched without its domain must hit the
 * bare-name route (which refuses ambiguity) rather than silently inventing a
 * domain, and a 409 from that route must reach the agent as an actionable
 * error rather than an empty result.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SemanticClient, SemanticApiError } from '../lib/client.js';

/** Records the request the client would make, and replies with `body`. */
function recorder(status = 200, body = { success: true }) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options?.method, body: options?.body ? JSON.parse(options.body) : undefined });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { calls, fetchImpl };
}

function clientWith(rec) {
  return new SemanticClient({
    apiKey: 'dvrc_test',
    baseUrl: 'https://api.test',
    fetchImpl: rec.fetchImpl,
  });
}

test('ofpModels hits the models endpoint', async () => {
  const rec = recorder();
  await clientWith(rec).ofpModels();
  assert.equal(rec.calls[0].url, 'https://api.test/api/v1/ofp/models');
  assert.equal(rec.calls[0].method, 'GET');
});

test('ofpEntities builds a query string only from supplied filters', async () => {
  const rec = recorder();
  const c = clientWith(rec);
  await c.ofpEntities();
  await c.ofpEntities({ q: 'methane', limit: 5 });
  await c.ofpEntities({ domain: 'Product Life Cycle' });
  assert.equal(rec.calls[0].url, 'https://api.test/api/v1/ofp/entities');
  assert.equal(rec.calls[1].url, 'https://api.test/api/v1/ofp/entities?q=methane&limit=5');
  assert.equal(rec.calls[2].url, 'https://api.test/api/v1/ofp/entities?domain=Product+Life+Cycle');
});

test('ofpEntity uses the qualified route when a domain is given', async () => {
  const rec = recorder();
  await clientWith(rec).ofpEntity('Product Carbon Footprint', 'Product Life Cycle');
  assert.equal(
    rec.calls[0].url,
    'https://api.test/api/v1/ofp/entities/Product%20Life%20Cycle/Product%20Carbon%20Footprint'
  );
});

test('ofpEntity without a domain uses the bare route, which refuses ambiguity', async () => {
  const rec = recorder();
  await clientWith(rec).ofpEntity('Country');
  assert.equal(rec.calls[0].url, 'https://api.test/api/v1/ofp/entities/Country');
});

test('a 409 on an ambiguous entity surfaces as an error carrying the candidates', async () => {
  const rec = recorder(409, {
    success: false,
    error: 'ambiguous_entity_name',
    message: '"Country" is defined in 4 domains.',
    candidates: [{ qualifiedId: 'common-entities/country' }, { qualifiedId: 'facility-structure/country' }],
  });
  await assert.rejects(
    () => clientWith(rec).ofpEntity('Country'),
    (err) => {
      assert.ok(err instanceof SemanticApiError);
      assert.equal(err.status, 409);
      assert.equal(err.detail.error, 'ambiguous_entity_name');
      assert.equal(err.detail.candidates.length, 2);
      return true;
    }
  );
});

test('ofpSectors passes an axis filter through', async () => {
  const rec = recorder();
  const c = clientWith(rec);
  await c.ofpSectors();
  await c.ofpSectors('sics');
  assert.equal(rec.calls[0].url, 'https://api.test/api/v1/ofp/sectors');
  assert.equal(rec.calls[1].url, 'https://api.test/api/v1/ofp/sectors?axis=sics');
});

test('ofpPolicies returns an unpublished answer as data, not an error', async () => {
  const rec = recorder(200, {
    success: true,
    data: { sector: 'production-processing', published: false, reason: 'No policy guardrails are published', policies: [] },
  });
  const out = await clientWith(rec).ofpPolicies('production-processing');
  assert.equal(rec.calls[0].url, 'https://api.test/api/v1/ofp/sectors/production-processing/policies');
  assert.equal(out.data.published, false);
  assert.match(out.data.reason, /no policy guardrails are published/i);
});

test('ofpValidate posts only the fields that were supplied', async () => {
  const rec = recorder();
  const c = clientWith(rec);
  await c.ofpValidate({ entity: 'Product Carbon Footprint', payload: { a: 1 } });
  await c.ofpValidate({ entity: 'X', domain: 'D', payload: { a: 1 }, sector: 'extractives' });
  assert.equal(rec.calls[0].method, 'POST');
  assert.deepEqual(rec.calls[0].body, { entity: 'Product Carbon Footprint', payload: { a: 1 } });
  assert.deepEqual(rec.calls[1].body, { entity: 'X', domain: 'D', payload: { a: 1 }, sector: 'extractives' });
});

test('a 402 from validate keeps the actionable top-up guidance', async () => {
  const rec = recorder(402, { error: 'insufficient_credits', balance: 0, needed: 1, purchaseUrl: '/api/v1/vaas/credits/purchase' });
  await assert.rejects(
    () => clientWith(rec).ofpValidate({ entity: 'X', payload: {} }),
    (err) => {
      assert.equal(err.status, 402);
      assert.ok(err.actionable, 'a 402 must carry actionable guidance for the operator');
      return true;
    }
  );
});

test('ofpMeta hits the provenance endpoint', async () => {
  const rec = recorder();
  await clientWith(rec).ofpMeta();
  assert.equal(rec.calls[0].url, 'https://api.test/api/v1/ofp/meta');
});

test('ofpConvert posts only the fields that were supplied', async () => {
  const rec = recorder();
  await clientWith(rec).ofpConvert({ value: 2500, fromUnit: 'kWh', toUnit: 'MW.h' });
  assert.equal(rec.calls[0].url, 'https://api.test/api/v1/ofp/convert');
  assert.equal(rec.calls[0].method, 'POST');
  assert.deepEqual(rec.calls[0].body, { value: 2500, fromUnit: 'kWh', toUnit: 'MW.h' });
});

test('ofpConvert forwards an assumption and dictionary pin verbatim', async () => {
  const rec = recorder();
  const assumption = { kind: 'calorificValue', value: 10.5, unit: 'kW.h', perUnit: 'm3', basis: 'gross' };
  await clientWith(rec).ofpConvert({
    value: 1, fromUnit: 'm3', toUnit: 'kW.h', assumption, dictionary: 'energistics-uom@1.0',
  });
  assert.deepEqual(rec.calls[0].body, {
    value: 1, fromUnit: 'm3', toUnit: 'kW.h', assumption, dictionary: 'energistics-uom@1.0',
  });
});

test('a 422 conversion refusal keeps its status and body for the tool layer', async () => {
  const rec = recorder(422, {
    success: false,
    error: 'assumption_required',
    message: 'm3 to kW.h crosses dimensions; declare an assumption.',
    detail: { kind: 'calorificValue' },
  });
  await assert.rejects(
    () => clientWith(rec).ofpConvert({ value: 1, fromUnit: 'm3', toUnit: 'kW.h' }),
    (err) => {
      assert.ok(err instanceof SemanticApiError);
      assert.equal(err.status, 422);
      assert.equal(err.detail.error, 'assumption_required');
      assert.deepEqual(err.detail.detail, { kind: 'calorificValue' });
      return true;
    }
  );
});

test('ofpUnits builds the query only from supplied filters', async () => {
  const rec = recorder();
  const c = clientWith(rec);
  await c.ofpUnits();
  await c.ofpUnits({ code: 'gal[US]' });
  await c.ofpUnits({ quantity: 'volume', detail: 'full', limit: 5, offset: 0 });
  assert.equal(rec.calls[0].url, 'https://api.test/api/v1/ofp/units');
  assert.equal(rec.calls[0].method, 'GET');
  assert.equal(rec.calls[1].url, 'https://api.test/api/v1/ofp/units?code=gal%5BUS%5D');
  // offset=0 is a meaningful first page and must survive.
  assert.equal(
    rec.calls[2].url,
    'https://api.test/api/v1/ofp/units?quantity=volume&detail=full&limit=5&offset=0'
  );
});

test('a 422 on an unresolved unit keeps its candidates for the tool layer', async () => {
  const rec = recorder(422, {
    success: false,
    error: 'unresolved_unit',
    message: 'No dictionary entry for unit "mwhh".',
    detail: { candidates: ['MW.h'] },
  });
  await assert.rejects(
    () => clientWith(rec).ofpUnits({ code: 'mwhh' }),
    (err) => {
      assert.equal(err.status, 422);
      assert.deepEqual(err.detail.detail.candidates, ['MW.h']);
      return true;
    }
  );
});
