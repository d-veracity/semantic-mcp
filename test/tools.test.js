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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  assert.equal(tools.length, 18, 'all 18 tools register');
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

test('the compliance tools are strict, read-only, and reject a non-uuid id (#258)', async () => {
  const client = await connected();
  const { tools } = await client.listTools();
  for (const name of ['compliance_policies', 'compliance_policy']) {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `${name} registers`);
    assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(t.annotations.destructiveHint, false);
    assert.equal(t.inputSchema.additionalProperties, false);
    const res = await client.callTool({ name, arguments: { __unexpected_param__: 'xyzzy', id: '11111111-1111-4111-8111-111111111111' } });
    assert.equal(res.isError, true, `${name} must reject an unknown key`);
  }
  const bad = await client.callTool({ name: 'compliance_policy', arguments: { id: 'not-a-uuid' } });
  assert.equal(bad.isError, true, 'a non-uuid id is rejected before any request');
  const ok = await client.callTool({ name: 'compliance_policies', arguments: { framework: 'CSRD', include_retired: true } });
  assert.equal(ok.isError, undefined);
});

/**
 * Descriptions must not hard-code a model census (dVE#375).
 *
 * "eight domains", "239 entities", "48 entity names" and "one field in the
 * model declares a bound today" each went stale when the vendored snapshot
 * moved, and in every case the card kept asserting a number the served model
 * no longer agreed with. An agent cannot cross-check a card against a response
 * it has not made yet, so the card has to point at the response instead:
 * ofp_models carries the served counts, and ofp_validate carries `checked` and
 * `schema.coverage.constraintsDeclared` per call.
 *
 * The patterns are deliberately narrow — a number attached to a model noun.
 * They leave alone the legitimate numbers a card also carries: argument limits,
 * a default page size, version strings, and the ofp_semantic_code threshold
 * ("more than ten fields"), which is fixed in the backend rather than read off
 * the snapshot. Singular "one" is excepted from the spelled-out pattern because
 * "more than one domain" describes ambiguity, not a census.
 */
const MODEL_COUNT_PATTERNS = [
  { re: /\b\d+\s+(?:fields?|entit(?:y|ies)|domains?)\b/i, label: 'digit count of model fields/entities/domains' },
  { re: /\bone field\b/i, label: '"one field" — the dVE#375 claim' },
  {
    re: /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand)\s+(?:domains?|entit(?:y|ies))\b/i,
    label: 'spelled-out count of model domains/entities',
  },
];

/** Every string an agent reads off tools/list: the card itself and each argument. */
function descriptionStrings(t) {
  const out = [[t.name, t.description || '']];
  const props = (t.inputSchema && t.inputSchema.properties) || {};
  for (const [arg, schema] of Object.entries(props)) {
    if (schema && typeof schema.description === 'string') out.push([`${t.name}.${arg}`, schema.description]);
  }
  return out;
}

test('no tool description hard-codes a model census (#375)', async () => {
  const client = await connected();
  const { tools } = await client.listTools();
  assert.ok(tools.length > 0, 'tools/list is populated');
  const offenders = [];
  for (const t of tools) {
    for (const [where, text] of descriptionStrings(t)) {
      for (const { re, label } of MODEL_COUNT_PATTERNS) {
        const m = text.match(re);
        if (m) offenders.push(`${where}: "${m[0]}" (${label})`);
      }
    }
  }
  assert.deepEqual(
    offenders, [],
    'a description must point at a served value, not a number:\n  ' + offenders.join('\n  ')
  );
});

test('ofp_validate points at the per-call evidence for value_range (#375)', async () => {
  const client = await connected();
  const { tools } = await client.listTools();
  const t = tools.find((x) => x.name === 'ofp_validate');
  assert.ok(t, 'ofp_validate registers');
  // The guardrail is the instruction to read the response, so it must survive
  // any future rewording of the count-free sentence around it.
  assert.match(t.description, /read `checked`/, 'still tells the agent to read `checked` per call');
  assert.match(t.description, /schema\.coverage\.constraintsDeclared/, 'cites the served constraint census');
  assert.doesNotMatch(t.description, /one field/i, 'the stale dVE#375 claim is gone');
});

test('the shipped README hard-codes no model census either (#375)', async () => {
  // README.md is in package.json's `files` whitelist, so it ships in the npm
  // tarball and carries the same authority as a tool card. It held the #375
  // sentence verbatim alongside "one generic code covers 255 fields" when the
  // served model said 31.
  const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
  const offenders = [];
  readme.split('\n').forEach((line, i) => {
    for (const { re, label } of MODEL_COUNT_PATTERNS) {
      const m = line.match(re);
      if (m) offenders.push(`README.md:${i + 1}: "${m[0]}" (${label})`);
    }
  });
  assert.deepEqual(
    offenders, [],
    'README must point at a served value, not a number:\n  ' + offenders.join('\n  ')
  );
});
