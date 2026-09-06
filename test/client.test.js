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
