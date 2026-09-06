/**
 * KERI-mode client tests: session acquisition, header attachment, transparent
 * re-auth on session rejection, and scope-denial shaping. No network, no fs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SemanticClient } from '../lib/client.js';

const PRESENTATION = '{"v":"ACDC10JSON00fake_"}-FAKECESR';

function keriFetchStub(log, { failFirstQuery = false } = {}) {
  let sessionCounter = 0;
  let queryCalls = 0;
  return async (url, opts) => {
    const path = new URL(url).pathname;
    log.push({ path, headers: opts.headers });
    if (path === '/api/v1/semantic/auth/challenge') {
      return { ok: true, status: 200, json: async () => ({ nonce: 'nonce-1', expiresIn: 300 }) };
    }
    if (path === '/api/v1/semantic/auth/keri') {
      sessionCounter++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessionToken: `sess-${sessionCounter}`,
          expiresIn: 3600,
          aid: 'EAGENT',
          lei: '529900T8BM49AURSDO55',
          scopes: ['semantic:query'],
          credentialSaid: 'ECRED',
        }),
      };
    }
    if (path === '/api/v1/semantic/query') {
      queryCalls++;
      if (failFirstQuery && queryCalls === 1) {
        return {
          ok: false,
          status: 401,
          json: async () => ({ success: false, message: 'Invalid or expired KERI session — re-authenticate' }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: { answer: 'ok' } }) };
    }
    throw new Error(`unexpected path ${path}`);
  };
}

function makeKeriClient(log, opts) {
  return new SemanticClient({
    apiKey: 'dvrc_test',
    keriAid: 'EAGENT',
    keriPresentationPath: '/fake/agent.cesr',
    readFileImpl: async () => PRESENTATION,
    fetchImpl: keriFetchStub(log, opts),
  });
}

test('keri mode acquires a session and attaches X-Keri-Session to metered calls', async () => {
  const log = [];
  const client = makeKeriClient(log);
  const out = await client.query('total emissions');
  assert.equal(out.data.answer, 'ok');
  const queryCall = log.find((l) => l.path === '/api/v1/semantic/query');
  assert.equal(queryCall.headers['X-Keri-Session'], 'sess-1');
  assert.equal(queryCall.headers['X-Api-Key'], 'dvrc_test');
  const exchange = log.find((l) => l.path === '/api/v1/semantic/auth/keri');
  assert.ok(exchange, 'exchange happened');
  assert.equal(exchange.headers['X-Keri-Session'], undefined, 'auth calls carry no session');
});

test('session is reused across calls within its lifetime', async () => {
  const log = [];
  const client = makeKeriClient(log);
  await client.query('one');
  await client.query('two');
  const exchanges = log.filter((l) => l.path === '/api/v1/semantic/auth/keri');
  assert.equal(exchanges.length, 1);
});

test('rejected KERI session triggers one transparent re-auth and retry', async () => {
  const log = [];
  const client = makeKeriClient(log, { failFirstQuery: true });
  const out = await client.query('retry me');
  assert.equal(out.data.answer, 'ok');
  const exchanges = log.filter((l) => l.path === '/api/v1/semantic/auth/keri');
  assert.equal(exchanges.length, 2, 're-authenticated once');
  const lastQuery = log.filter((l) => l.path === '/api/v1/semantic/query').pop();
  assert.equal(lastQuery.headers['X-Keri-Session'], 'sess-2');
});

test('scope denial is shaped with actionable guidance', async () => {
  const client = new SemanticClient({
    apiKey: 'dvrc_test',
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      json: async () => ({
        success: false,
        error: 'insufficient_scope',
        message: "does not carry the 'semantic:query' scope",
        required: 'semantic:query',
        carried: ['vaas:validate'],
      }),
    }),
  });
  await assert.rejects(
    () => client.query('q'),
    (err) => {
      assert.equal(err.status, 403);
      assert.match(err.actionable, /vaas:validate/);
      assert.match(err.actionable, /semantic:query/);
      assert.match(err.actionable, /human operator/);
      return true;
    }
  );
});

test('unreadable presentation file is actionable', async () => {
  const client = new SemanticClient({
    apiKey: 'dvrc_test',
    keriAid: 'EAGENT',
    keriPresentationPath: '/missing.cesr',
    readFileImpl: async () => {
      throw new Error('ENOENT');
    },
    fetchImpl: async () => {
      throw new Error('should not fetch');
    },
  });
  await assert.rejects(() => client.query('q'), /Cannot read KERI presentation/);
});

test('without keri config, no session flow happens', async () => {
  const log = [];
  const client = new SemanticClient({
    apiKey: 'dvrc_test',
    fetchImpl: async (url, opts) => {
      log.push(new URL(url).pathname);
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  await client.templates();
  assert.deepEqual(log, ['/api/v1/semantic/templates']);
  assert.equal(client.keriEnabled(), false);
});
