/**
 * Catalogue copy tests (v0.8.2 Item 2).
 *
 * Directory listings show the human title and the lead sentence, not the
 * snake_case tool name. This pins the copy for all 25 tools, the deprecated
 * credits_balance wording, and the commerce-restricted surface: same titles
 * and leads, no price text, and no checkout tools.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../lib/tools.js';

const TITLE_SNAPSHOT = {
  semantic_query: 'Query verified emissions data',
  semantic_templates: 'Emissions data: question templates',
  credits_balance: 'Credit balance (deprecated)',
  list_standards: 'List supported standards',
  validate_data: 'Validate data against a named standard',
  keri_identity: 'Verified agent identity (vLEI)',
  ofp_models: 'Open Footprint: list model domains',
  ofp_search_entities: 'Open Footprint: search entities',
  ofp_entity: 'Open Footprint: get entity definition',
  ofp_sectors: 'Open Footprint: list industry sectors',
  ofp_sector: 'Open Footprint: get sector',
  ofp_policies: 'Open Footprint: sector guardrails',
  ofp_semantics: 'Open Footprint: semantic codes for mapping',
  ofp_semantic_code: 'Open Footprint: fields for a semantic code',
  ofp_model_provenance: 'Open Footprint: model version',
  ofp_validate: 'Validate data against Open Footprint',
  compliance_policies: 'Regulatory checks: list policies',
  compliance_policy: 'Regulatory checks: get policy',
  compliance_evaluate: 'Regulatory checks: evaluate record or CBAM declaration',
  compliance_evaluation: 'Regulatory checks: get stored result',
  compliance_policy_register: 'Regulatory checks: what a policy covers',
  billing_plans: 'Plans and prices',
  billing_status: 'Account balance and plan',
  billing_purchase: 'Start a credit purchase (human pays)',
  billing_subscribe: 'Start a subscription (human approves)',
};

const CHECKOUT_TOOLS = new Set(['billing_purchase', 'billing_subscribe']);
const METERED_LEADS = ['semantic_query', 'validate_data', 'ofp_validate'];

function stubClient() {
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'keriEnabled') return () => false;
      return async () => ({ ok: true });
    },
  });
}

const catalogueSchema = ListToolsResultSchema.extend({
  tools: ListToolsResultSchema.shape.tools.element.passthrough().array(),
});

async function catalogue(options) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTools(server, stubClient(), options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.request({ method: 'tools/list' }, catalogueSchema);
    return tools;
  } finally {
    await client.close();
    await server.close();
  }
}

/**
 * The catalogue display copy an operator or agent reads. Argument descriptions
 * are excluded: they name regulation fields such as
 * `carbon_price_reduction_tco2e`, which are data definitions, not price copy.
 */
function copyOf(tool) {
  return [
    tool.name,
    tool.title || '',
    tool.description || '',
  ].join('\n');
}

test('every tool carries the human title at the top level', async () => {
  const tools = await catalogue();
  assert.deepEqual(
    Object.fromEntries(tools.map((tool) => [tool.name, tool.title])),
    TITLE_SNAPSHOT
  );
  for (const tool of tools) {
    assert.notEqual(tool.title, tool.name, `${tool.name} title is still the tool name`);
    assert.doesNotMatch(tool.title, /_/, `${tool.name} title is snake_case`);
    // The title is advertised once, at the top level: repeating it in
    // annotations spends tools/list budget on the same string twice.
    assert.equal(tool.annotations.title, undefined, `${tool.name} repeats annotations.title`);
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      assert.equal(typeof tool.annotations[hint], 'boolean', `${tool.name}.${hint} is missing`);
    }
  }
});

test('every description opens with a lead sentence', async () => {
  const tools = await catalogue();
  for (const tool of tools) {
    if (tool.name === 'credits_balance') {
      assert.match(tool.description, /^Deprecated:/, 'credits_balance must lead with Deprecated:');
      assert.match(tool.description, /billing_status/, 'credits_balance names its replacement');
      assert.match(tool.description, /0\.9/, 'credits_balance states the removal release');
    } else {
      assert.match(tool.description, /^Use this when/, `${tool.name} lacks its lead sentence`);
    }
  }
});

test('the catalogue stays inside the directory token budget', async () => {
  const tools = await catalogue();
  for (const tool of tools) {
    assert.ok(
      tool.description.length <= 1000,
      `${tool.name} description is ${tool.description.length} characters`
    );
  }
  const bytes = Buffer.byteLength(JSON.stringify({ tools }));
  assert.ok(bytes < 20 * 1024, `tools/list is ${bytes} bytes`);
});

test('metered leads keep their price text on the unrestricted surface', async () => {
  const tools = await catalogue();
  for (const name of METERED_LEADS) {
    const tool = tools.find((entry) => entry.name === name);
    assert.match(tool.description, /\$0\.01/, `${name} lost its price`);
    assert.match(tool.description, /1 credit/, `${name} lost its credit price`);
  }
});

test('the commerce-restricted surface keeps titles and leads without price text', async () => {
  const tools = await catalogue({ commerceRestricted: true });
  const names = tools.map((tool) => tool.name);
  assert.equal(tools.length, Object.keys(TITLE_SNAPSHOT).length - CHECKOUT_TOOLS.size);
  for (const hidden of CHECKOUT_TOOLS) {
    assert.ok(!names.includes(hidden), `${hidden} must not be registered`);
  }
  for (const tool of tools) {
    if (tool.name === 'credits_balance') {
      assert.match(tool.description, /^Deprecated:/);
    } else {
      assert.match(tool.description, /^Use this when/, `${tool.name} lacks its lead sentence`);
    }
    const expectedTitle = tool.name === 'billing_plans'
      ? 'Plans and allowances'
      : TITLE_SNAPSHOT[tool.name];
    assert.equal(tool.title, expectedTitle, `${tool.name} title differs on the restricted surface`);
    assert.equal(tool.annotations.title, undefined, `${tool.name} repeats annotations.title`);
  }
  const restrictedCopy = tools.map(copyOf).join('\n');
  for (const banned of [/\$/, /\bprice/i, /\bpurchas/i, /\bsubscrib/i, /\bupgrad/i,
    /\bcheckout\b/i, /Costs API credits/i]) {
    assert.doesNotMatch(restrictedCopy, banned, `restricted catalogue still says ${banned}`);
  }
});
