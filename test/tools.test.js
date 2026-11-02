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
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../lib/tools.js';
import { SemanticApiError } from '../lib/client.js';
import { TOOL_SCOPES, NOAUTH_TOOLS, enforceToolScopes } from '../lib/scopes.cjs';

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

async function connected(clientImpl = stubClient(), options) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTools(server, clientImpl);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  enforceToolScopes(serverTransport, options?.authInfo, options?.resourceMetadataUrl);
  await client.connect(clientTransport);
  return client;
}

const textOf = (res) => (res.content || []).map((c) => c.text).join('');

test('every tool publishes identical OAuth requirements at both metadata locations', async () => {
  const client = await connected();
  try {
    const schema = ListToolsResultSchema.extend({
      tools: ListToolsResultSchema.shape.tools.element.passthrough().array(),
    });
    const { tools } = await client.request({ method: 'tools/list' }, schema);
    assert.deepEqual(tools.map((tool) => tool.name).sort(), Object.keys(TOOL_SCOPES).sort());
    for (const tool of tools) {
      const scope = TOOL_SCOPES[tool.name];
      const expected = NOAUTH_TOOLS.includes(tool.name)
        ? [{ type: 'noauth' }]
        : [{ type: 'oauth2', scopes: scope ? [scope] : [] }];
      assert.deepEqual(tool.securitySchemes, expected, tool.name);
      assert.deepEqual(tool._meta.securitySchemes, expected, tool.name);
    }
  } finally {
    await client.close();
  }
});

test('a read grant reads evaluations but receives an actionable step-up for evaluate', async () => {
  let evaluated = false;
  const client = await connected({
    keriEnabled: () => false,
    complianceEvaluation: async () => STUB_PAYLOAD,
    complianceEvaluate: async () => { evaluated = true; return STUB_PAYLOAD; },
  }, {
    authInfo: { scopes: ['compliance:read'] },
    resourceMetadataUrl: 'https://api.dveracity.com/.well-known/oauth-protected-resource/mcp',
  });
  try {
    const allowed = await client.callTool({ name: 'compliance_evaluation', arguments: { evaluation_id: EVAL_ID } });
    assert.notEqual(allowed.isError, true);
    const denied = await client.callTool({ name: 'compliance_evaluate', arguments: { policy_id: POLICY_ID, entity: {} } });
    assert.equal(denied.isError, true);
    assert.match(textOf(denied), /compliance:evaluate/);
    assert.match(denied._meta['mcp/www_authenticate'][0], /error="insufficient_scope"/);
    assert.match(denied._meta['mcp/www_authenticate'][0], /scope="compliance:evaluate"/);
    const malformed = await client.callTool({ name: 'compliance_evaluate', arguments: {} });
    assert.equal(malformed.isError, true);
    assert.deepEqual(malformed._meta, denied._meta);
    assert.equal(evaluated, false);
  } finally {
    await client.close();
  }
});

test('every tool advertises additionalProperties:false (#11 P1+P2)', async () => {
  const client = await connected();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 25, 'all 25 tools register');
  for (const t of tools) {
    assert.equal(
      t.inputSchema.additionalProperties, false,
      `${t.name} must advertise additionalProperties:false`
    );
  }
});

test('every tool carries _meta.pricing in credits, with free tools at 0', async () => {
  const client = await connected();
  const { tools } = await client.listTools();
  const METERED = new Set(['semantic_query', 'validate_data', 'ofp_validate']);
  for (const t of tools) {
    assert.ok(t._meta && t._meta.pricing, `${t.name} must carry _meta.pricing`);
    const p = t._meta.pricing;
    assert.equal(p.unit, 'credit');
    assert.equal(typeof p.amount, 'number');
    assert.equal(typeof p.usd, 'number');
    if (METERED.has(t.name)) assert.ok(p.amount > 0, `${t.name} is metered`);
    else assert.equal(p.amount, 0, `${t.name} is free`);
    if (p.amount === 0) assert.equal(p.usd, 0, `${t.name} free tools cost $0`);
  }
});

test('plan-gated tools name their plan, so 0 credits is not read as free', async () => {
  const client = await connected();
  const { tools } = await client.listTools();
  for (const name of ['compliance_policies', 'compliance_policy', 'compliance_policy_register',
    'compliance_evaluation', 'compliance_evaluate']) {
    assert.equal(tools.find((t) => t.name === name)._meta.pricing.plan_required, 'vaas', name);
    assert.equal(
      tools.find((t) => t.name === name)._meta.pricing.plan_required_ref,
      'billing_plans#vaas', name
    );
  }
  assert.equal(tools.find((t) => t.name === 'ofp_models')._meta.pricing.plan_required, undefined);
  assert.equal(tools.find((t) => t.name === 'ofp_models')._meta.pricing.plan_required_ref, undefined);
});

test('billing_subscribe offers only memberships that are sold', async () => {
  const client = await connected();
  const { tools } = await client.listTools();
  const subscribe = tools.find((t) => t.name === 'billing_subscribe');
  assert.deepEqual(subscribe.inputSchema.properties.plan.enum, ['api', 'enterprise']);
});

test('no description promises a paymentLink the deployment may not configure', async () => {
  const client = await connected();
  const { tools } = await client.listTools();
  for (const t of tools) {
    assert.doesNotMatch(t.description || '', /return a payment link and checkoutUrl/i, t.name);
  }
});

test('the billing tools register and are strict', async () => {
  const client = await connected();
  const { tools } = await client.listTools();
  for (const name of ['billing_plans', 'billing_status', 'billing_purchase', 'billing_subscribe']) {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `${name} registers`);
    assert.equal(t.inputSchema.additionalProperties, false);
    assert.equal(t.annotations.destructiveHint, false);
  }
  const bad = await client.callTool({ name: 'billing_purchase', arguments: { credit_pack: '42' } });
  assert.equal(bad.isError, true, 'an unknown credit pack is rejected before any request');
  const ok = await client.callTool({ name: 'billing_status', arguments: {} });
  assert.notEqual(ok.isError, true);
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

const POLICY_ID = 'e8caab5f-5516-465b-ae7f-526d8e736990';
const EVAL_ID = '9f1c0a52-2c66-4b8e-8e43-2c5e4a3f1b77';

test('compliance_evaluate executes a named policy and passes the record through', async () => {
  let captured;
  const client = await connected({
    keriEnabled: () => false,
    complianceEvaluate: async (args) => {
      captured = args;
      return { decision: 'passed', allow: true, coverage: { rules_total: 70, rendered_checks: 26 } };
    },
  });
  const { tools } = await client.listTools();
  const evaluate = tools.find((t) => t.name === 'compliance_evaluate');
  assert.ok(evaluate, 'compliance_evaluate registers');
  // It writes an audit record, so it is the one tool that is not read-only.
  assert.equal(evaluate.annotations.readOnlyHint, false);
  assert.equal(evaluate.annotations.destructiveHint, false);
  assert.equal(evaluate.annotations.idempotentHint, false);
  assert.equal(evaluate.inputSchema.additionalProperties, false);
  // The card must send the agent to the encoded-checks caveat, not imply total coverage.
  assert.match(evaluate.description, /not the generic OFP validator/);
  assert.match(evaluate.description, /coverage\.note/);
  assert.match(evaluate.description, /compliance:evaluate scope/);
  // A refusal is an error decision, not a transport failure: the card names the
  // decision value and the codes, so an agent can tell them apart from a pass.
  assert.match(evaluate.description, /not_applicable/);
  for (const code of [
    'policy_not_release_eligible',
    'policy_no_rendered_checks',
    'policy_no_faithful_checks',
    'policy_coverage_inconsistent',
  ]) {
    assert.ok(evaluate.description.includes(code), `the card names ${code}`);
  }

  const ok = await client.callTool({
    name: 'compliance_evaluate',
    arguments: { policy_id: POLICY_ID, entity: { cn_code: '7601 10 00' } },
  });
  assert.notEqual(ok.isError, true);
  assert.deepEqual(JSON.parse(textOf(ok)), { decision: 'passed', allow: true, coverage: { rules_total: 70, rendered_checks: 26 } });
  assert.equal(captured.policy_id, POLICY_ID);

  const bad = await client.callTool({ name: 'compliance_evaluate', arguments: { policy_id: 'not-a-uuid', entity: {} } });
  assert.equal(bad.isError, true, 'a non-uuid policy_id is rejected before any request');
});

test('compliance_evaluate accepts an annual declaration without an entity', async () => {
  let captured;
  const client = await connected({
    keriEnabled: () => false,
    complianceEvaluate: async (args) => {
      captured = args;
      return { decision: 'passed', allow: true, entity_type: 'cbam_declaration' };
    },
  });
  const { tools } = await client.listTools();
  const evaluate = tools.find((t) => t.name === 'compliance_evaluate');
  assert.ok(evaluate.inputSchema.properties.declaration, 'the declaration object is published');
  assert.ok(evaluate.inputSchema.properties.lines, 'the lines array is published');
  assert.match(evaluate.description, /cbam_declaration/);

  const res = await client.callTool({
    name: 'compliance_evaluate',
    arguments: {
      policy_id: POLICY_ID,
      entity_type: 'cbam_declaration',
      declaration: { declaration_id: 'decl-2026', reporting_year: 2026 },
      lines: [{ declaration_line_id: 'l1', record_id: 'cm-1' }],
    },
  });
  assert.notEqual(res.isError, true);
  assert.equal(captured.entity_type, 'cbam_declaration');
  assert.equal(captured.declaration.declaration_id, 'decl-2026');
  assert.equal(captured.lines[0].record_id, 'cm-1');
});

test('a 422 error decision is shown to the agent, not flattened into a transport error', async () => {
  const detail = {
    success: true,
    evaluation_id: EVAL_ID,
    decision: 'error',
    allow: false,
    error: { code: 'policy_hash_mismatch', message: 'The retained Rego hashes to x but the approved hash is y.' },
  };
  const client = await connected({
    keriEnabled: () => false,
    complianceEvaluate: async () => {
      throw new SemanticApiError('dVeracity API error 422: refusing to evaluate', { status: 422, detail });
    },
  });
  const res = await client.callTool({ name: 'compliance_evaluate', arguments: { policy_id: POLICY_ID, entity: {} } });
  assert.equal(res.isError, true);
  // The body is the audit record; a bare "API error 422" would hide the reason.
  assert.deepEqual(JSON.parse(textOf(res)), detail);
});

test('compliance_evaluation and compliance_policy_register are strict and read-only', async () => {
  let evaluationId;
  let policyId;
  const client = await connected({
    keriEnabled: () => false,
    complianceEvaluation: async (id) => { evaluationId = id; return { evaluation_id: id, decision: 'passed' }; },
    compliancePolicyRegister: async (id) => { policyId = id; return { policy_id: id, rules_total: 70 }; },
  });
  const { tools } = await client.listTools();
  for (const name of ['compliance_evaluation', 'compliance_policy_register']) {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `${name} registers`);
    assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(t.annotations.destructiveHint, false);
    assert.equal(t.inputSchema.additionalProperties, false);
  }
  const unknown = await client.callTool({
    name: 'compliance_evaluation',
    arguments: { evaluation_id: EVAL_ID, __unexpected_param__: 'xyzzy' },
  });
  assert.equal(unknown.isError, true, 'an unknown key is rejected');
  const evaluation = await client.callTool({ name: 'compliance_evaluation', arguments: { evaluation_id: EVAL_ID } });
  assert.notEqual(evaluation.isError, true);
  assert.equal(evaluationId, EVAL_ID);
  const register = await client.callTool({ name: 'compliance_policy_register', arguments: { id: POLICY_ID } });
  assert.notEqual(register.isError, true);
  assert.equal(policyId, POLICY_ID);
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
