/**
 * Tool argument-strictness tests (#11).
 *
 * The MCP SDK turns a raw Zod shape into a NON-strict object, so an unknown
 * argument used to be silently stripped: ofp_search_entities {"query": ...}
 * became {} and returned the same unfiltered listing as no argument at all --
 * inverting the answer for an LLM caller that cannot notice. registerTools now
 * builds every schema with z.object(shape).strict(), so unknown keys are
 * rejected with a message naming the key, and every published inputSchema
 * carries additionalProperties:false (the four no-argument tools used to omit
 * it, so they advertised a looser contract than the rest).
 *
 * These run over an in-memory transport with a stub client. Rejection happens
 * in the SDK's argument-validation layer, before any handler reaches the
 * network, so no API key or backend is required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../lib/tools.js';

const STUB_PAYLOAD = { ok: true };

/** Every client method resolves to a fixed shape; a rejected call never reaches it. */
function stubClient() {
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'keriEnabled') return () => false;
      return async () => STUB_PAYLOAD;
    },
  });
}

async function connected() {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTools(server, stubClient());
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

const textOf = (res) => (res.content || []).map((c) => c.text).join('');

test('every tool advertises additionalProperties:false (#11 P1+P2)', async () => {
  const client = await connected();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 16, 'all 16 tools register');
  for (const t of tools) {
    assert.equal(
      t.inputSchema.additionalProperties, false,
      `${t.name} must advertise additionalProperties:false`
    );
  }
});

test('the four no-argument tools reject an unknown key (#11 P2)', async () => {
  const client = await connected();
  for (const name of ['semantic_templates', 'list_standards', 'ofp_models', 'ofp_model_provenance']) {
    const res = await client.callTool({ name, arguments: { __unexpected_param__: 'xyzzy' } });
    assert.equal(res.isError, true, `${name} must reject an unknown key`);
    assert.match(textOf(res), /__unexpected_param__/, `${name} error must name the offending key`);
  }
});

test('a near-miss key is rejected, not silently dropped (#11 P3)', async () => {
  const client = await connected();
  const res = await client.callTool({ name: 'ofp_search_entities', arguments: { query: 'sequestration' } });
  assert.equal(res.isError, true, 'the mistyped "query" must be rejected');
  assert.match(textOf(res), /Unrecognized key/i);
  assert.match(textOf(res), /query/, 'the error must name the offending key');
});

test('a mistyped sector on ofp_validate is rejected, so it cannot be misattributed (#11 P4)', async () => {
  const client = await connected();
  const res = await client.callTool({
    name: 'ofp_validate',
    arguments: { entity: 'Emission Statement', domain: 'common-entities', payload: {}, sectorId: 'entertainment' },
  });
  assert.equal(res.isError, true, 'sectorId is not a parameter of ofp_validate');
  assert.match(textOf(res), /sectorId/, 'the error must name the offending key');
});

test('required-argument validation still fails cleanly with the Zod path (no regress)', async () => {
  const client = await connected();
  const res = await client.callTool({ name: 'ofp_entity', arguments: {} });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /-32602/, 'invalid-params code is preserved');
  assert.match(textOf(res), /Required/);
  assert.match(textOf(res), /name/, 'the message carries the Zod path of the missing argument');
});

test('a valid call still reaches the handler', async () => {
  const client = await connected();
  const res = await client.callTool({ name: 'ofp_search_entities', arguments: { q: 'emission' } });
  assert.notEqual(res.isError, true);
  assert.deepEqual(JSON.parse(textOf(res)), STUB_PAYLOAD);
});
