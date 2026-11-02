/**
 * SemanticClient unit tests (node --test, no network).
 * The 402/401 shaping is the product surface for AI agents — locked here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SemanticClient, SemanticApiError } from '../lib/client.js';

function fakeFetch(status, body) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

function makeClient(status, body) {
  return new SemanticClient({ apiKey: 'dvrc_test', fetchImpl: fakeFetch(status, body) });
}

test('missing API key throws with actionable guidance', () => {
  const prev = process.env.DVERACITY_API_KEY;
  delete process.env.DVERACITY_API_KEY;
  try {
    assert.throws(
      () => new SemanticClient({ fetchImpl: fakeFetch(200, {}) }),
      (err) => err instanceof SemanticApiError && /DVERACITY_API_KEY/.test(err.message)
    );
  } finally {
    if (prev !== undefined) process.env.DVERACITY_API_KEY = prev;
  }
});

test('successful query returns parsed body', async () => {
  const client = makeClient(200, { success: true, data: { answer: '42' } });
  const out = await client.query('total emissions');
  assert.equal(out.data.answer, '42');
});

test('402 becomes actionable payment-required error, no retry semantics', async () => {
  const client = makeClient(402, {
    error: 'insufficient_credits',
    balance: 0,
    needed: 1,
    purchaseUrl: '/api/v1/vaas/credits/purchase',
  });
  await assert.rejects(
    () => client.query('q'),
    (err) => {
      assert.equal(err.status, 402);
      assert.match(err.actionable, /human operator/);
      assert.match(err.actionable, /purchase credits/i);
      assert.match(err.actionable, /credits\/purchase/);
      return true;
    }
  );
});

test('401 names the API key as the problem', async () => {
  const client = makeClient(401, { success: false, message: 'Invalid or expired API key' });
  await assert.rejects(
    () => client.query('q'),
    (err) => err.status === 401 && /DVERACITY_API_KEY/.test(err.actionable)
  );
});

test('403 plan gate relays the refusal guidance instead of inventing an upgrade URL', async () => {
  const client = makeClient(403, {
    success: false,
    message: 'This feature requires a vaas subscription',
    requiredTier: 'vaas',
    currentTier: 'free',
    plansUrl: 'https://dveracity.com/pricing',
    note: 'VaaS is enabled by dVeracity; buying credit packs does not change the account tier. ' +
      'Ask your human operator to contact dVeracity to enable VaaS, then retry.',
  });
  await assert.rejects(
    () => client.query('q'),
    (err) => {
      assert.equal(err.status, 403);
      assert.match(err.actionable, /enabled by dVeracity/);
      assert.match(err.actionable, /credit packs/);
      assert.match(err.actionable, /https:\/\/dveracity\.com\/pricing/);
      assert.match(err.actionable, /Do not retry on your own/);
      assert.doesNotMatch(err.actionable, /upgrade at/);
      return true;
    }
  );
});

test('403 without guidance keeps the generic upgrade text', async () => {
  const client = makeClient(403, {
    success: false,
    message: 'This feature requires a api subscription',
    requiredTier: 'api',
    currentTier: 'free',
  });
  await assert.rejects(
    () => client.query('q'),
    (err) => err.status === 403 && /upgrade at https:\/\/dveracity\.com\/pricing/.test(err.actionable)
  );
});

test('5xx surfaces status and message', async () => {
  const client = makeClient(502, { success: false, message: 'Semantic backend unavailable' });
  await assert.rejects(() => client.query('q'), /502.*Semantic backend unavailable/);
});

test('network failure is reported as unreachable', async () => {
  const client = new SemanticClient({
    apiKey: 'dvrc_test',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  await assert.rejects(() => client.query('q'), /unreachable/);
});

test('base URL trailing slash is normalized and key header sent', async () => {
  let captured;
  const client = new SemanticClient({
    apiKey: 'dvrc_test',
    baseUrl: 'https://api.example/',
    fetchImpl: async (url, opts) => {
      captured = { url, opts };
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  await client.templates();
  assert.equal(captured.url, 'https://api.example/api/v1/semantic/templates');
  assert.equal(captured.opts.headers['X-Api-Key'], 'dvrc_test');
});

function capturingClient(status, body) {
  const captured = {};
  const client = new SemanticClient({
    apiKey: 'dvrc_test',
    fetchImpl: async (url, opts) => {
      captured.url = url;
      captured.opts = opts;
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    },
  });
  return { client, captured };
}

test('complianceEvaluate posts the named policy and omits absent optional fields', async () => {
  const { client, captured } = capturingClient(200, { decision: 'passed', allow: true });
  const out = await client.complianceEvaluate({ policy_id: 'p-1', entity: { cn_code: '7601 10 00' } });
  assert.equal(out.decision, 'passed');
  assert.equal(captured.url, 'https://dve-backend-xytsvgj3fq-ue.a.run.app/api/v1/compliance/evaluate');
  assert.equal(captured.opts.method, 'POST');
  assert.deepEqual(JSON.parse(captured.opts.body), {
    policy_id: 'p-1',
    entity: { cn_code: '7601 10 00' },
  });
});

test('complianceEvaluate forwards evidence, context and entity_type when supplied', async () => {
  const { client, captured } = capturingClient(200, {});
  await client.complianceEvaluate({
    policy_id: 'p-1',
    entity_type: 'carbon_measure',
    entity: {},
    context: { report_period: '2026-Q1' },
    evidence: [{ kind: 'installation', ref: 'installation/BR-ALU-01/2026-Q1', sha256: 'a'.repeat(64) }],
  });
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.entity_type, 'carbon_measure');
  assert.deepEqual(body.context, { report_period: '2026-Q1' });
  assert.equal(body.evidence.length, 1);
});

test('complianceEvaluate sends a declaration without an entity', async () => {
  const { client, captured } = capturingClient(200, {});
  await client.complianceEvaluate({
    policy_id: 'p-1',
    entity_type: 'cbam_declaration',
    declaration: { declaration_id: 'decl-2026', reporting_year: 2026 },
    lines: [{ declaration_line_id: 'l1', record_id: 'cm-1' }],
  });
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.entity_type, 'cbam_declaration');
  assert.equal(body.entity, undefined);
  assert.equal(body.declaration.declaration_id, 'decl-2026');
  assert.equal(body.lines.length, 1);
});

test('a 422 error decision keeps its status and body for the tool layer', async () => {
  const detail = { decision: 'error', allow: false, error: { code: 'policy_no_checks' } };
  const { client } = capturingClient(422, detail);
  await assert.rejects(
    () => client.complianceEvaluate({ policy_id: 'p-1', entity: {} }),
    (err) => err instanceof SemanticApiError && err.status === 422 && err.detail.error.code === 'policy_no_checks'
  );
});

test('complianceEvaluation and compliancePolicyRegister encode the id and use GET', async () => {
  const { client, captured } = capturingClient(200, {});
  await client.complianceEvaluation('eval-1');
  assert.equal(captured.url, 'https://dve-backend-xytsvgj3fq-ue.a.run.app/api/v1/compliance/evaluations/eval-1');
  assert.equal(captured.opts.method, 'GET');
  await client.compliancePolicyRegister('policy/with space');
  assert.equal(
    captured.url,
    'https://dve-backend-xytsvgj3fq-ue.a.run.app/api/v1/compliance/policies/policy%2Fwith%20space/register'
  );
  assert.equal(captured.opts.method, 'GET');
});
