/**
 * Shared tool registration for the dVeracity Semantic MCP server.
 *
 * Extracted from index.js so the same tool definitions serve both
 * the stdio entrypoint (for local agent use) and the remote HTTP
 * endpoint (for cloud-hosted MCP connectors). Two copies of these
 * registrations was the drift bug this codebase had been bitten by
 * four times.
 *
 * The function accepts an McpServer and a SemanticClient. The client
 * is captured by each tool handler's closure, so per-request identity
 * is achieved by constructing a fresh client and server pair.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SemanticApiError } from './client.js';
import scopes from './scopes.cjs';
import { pricingForTool } from './pricing.js';

const { securitySchemesForTool } = scopes;

/**
 * Human-readable catalogue copy.
 *
 * Directory listings (Claude, ChatGPT) show title and description, not the
 * snake_case tool name, so every tool carries a title an operator can read and
 * a lead sentence an agent can match a request against. The caveat prose each
 * registration already carried follows the lead unchanged.
 *
 * Commerce-restricted surfaces (config/clientCommerce in the backend) get the
 * same titles and leads minus price text: those platforms run commerce
 * themselves, so a connector must not quote costs or invite a purchase.
 */
const TOOL_TITLES = Object.freeze({
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
  ofp_units: 'Open Footprint: unit dictionary',
  ofp_convert: 'Open Footprint: convert units',
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
});

const TOOL_LEADS = Object.freeze({
  semantic_query:
    'Use this when a user asks a specific question about verified oil-and-gas emissions data, ' +
    'e.g. methane for a site or period (PPDM, OGMP 2.0). Call semantic_templates first. Not for ' +
    'general climate questions. Costs 1 credit ($0.01).',
  semantic_templates:
    'Use this when you want to see what the verified emissions data can answer, before ' +
    'semantic_query.',
  credits_balance:
    'Deprecated: use billing_status (also shows plan and free allowance). Removal planned ' +
    'for 0.9.x.',
  list_standards:
    'Use this when you need the standards and versions validate_data can check.',
  validate_data:
    'Use this when a payload needs checking against a non-Open-Footprint standard; call ' +
    'list_standards first. For Open Footprint use ofp_validate. Costs 1 credit ($0.01).',
  keri_identity:
    'Use this when an organisation needs to confirm which verified legal entity and agent ' +
    'identity calls are attributed to. Only with vLEI configured.',
  ofp_models:
    'Use this when building on Open Footprint and you need to know what the model covers. ' +
    'Start here before other ofp_ tools.',
  ofp_search_entities:
    'Use this when you need the Open Footprint entity for a concept ("Scope 3 emissions"). ' +
    'Not for emission factors or calculations.',
  ofp_entity:
    "Use this when you need one entity's fields, types, keys and relationships.",
  ofp_sectors:
    'Use this when a user asks which industries Open Footprint covers or a sector\'s ' +
    'implementation status.',
  ofp_sector:
    "Use this when you need one sector's classification, status and reference artifacts.",
  ofp_policies:
    "Use this when a user asks which validation rules apply to a sector's records. For " +
    'regulations use compliance_policies.',
  ofp_semantics:
    'Use this when mapping fields from SAP, an ERP or a supplier feed onto Open Footprint.',
  ofp_semantic_code:
    'Use this when you have a source-system field and need its place in the Open Footprint model.',
  ofp_model_provenance:
    'Use this when a user asks which Open Footprint version or extension packs this snapshot ' +
    "serves. Reports the source commit and per-pack id, kind, version, status, core range and " +
    'regulations. Gate adoption on status: drafts are for review, not adoption.',
  ofp_units:
    'Use this when you need unit codes before converting or validating. No args lists quantity ' +
    'types; quantity lists its units; code resolves one symbol or alias.',
  ofp_convert:
    'Use this when a measurement needs converting between units (kWh to MJ, bbl to m3). ' +
    'Resolve unsure codes with ofp_units first.',
  ofp_validate:
    'Use this when an emissions or footprint record (JSON) needs checking against Open Footprint ' +
    "or sector guardrails before storing or reporting. Not for data-quality questions without " +
    'a payload. Costs 1 credit ($0.01).',
  compliance_policies:
    'Use this when data needs checking against a regulation (e.g. EU CBAM): find the approved ' +
    'policy. For sector rules use ofp_policies.',
  compliance_policy:
    'Use this when you need one approved regulatory policy\'s rules, provenance and coverage.',
  compliance_evaluate:
    'Use this when an import record or annual EU CBAM declaration (Reg. (EU) 2023/956) needs ' +
    'an approved-policy check before filing. Not for footprint calculations or unlisted ' +
    'regulations.',
  compliance_evaluation:
    'Use this when a user wants to retrieve or audit a previous evaluation by its id.',
  compliance_policy_register:
    'Use this when a user asks which provisions of a regulation an evaluation checks.',
  billing_plans:
    'Use this when you need dVeracity costs, the free allowance, or options to show after a ' +
    'payment-required response.',
  billing_status:
    'Use this when a call was refused for credits or plan, to tell the user what is missing.',
  billing_purchase:
    'Use this when the user agrees to buy credits; returns a link the user must complete.',
  billing_subscribe:
    'Use this when the user wants a membership; returns a checkout link the user must complete.',
});

// Price text is removed from these leads on a commerce-restricted surface.
const RESTRICTED_LEADS = Object.freeze({
  ...TOOL_LEADS,
  semantic_query: TOOL_LEADS.semantic_query.replace(' Costs 1 credit ($0.01).', ''),
  validate_data: TOOL_LEADS.validate_data.replace(' Costs 1 credit ($0.01).', ''),
  ofp_validate: TOOL_LEADS.ofp_validate.replace(' Costs 1 credit ($0.01).', ''),
  billing_plans:
    'Use this when you need to know what each dVeracity plan includes or what the free ' +
    'allowance covers.',
});

// "Plans and prices" is the human title, but the word itself is price text.
const RESTRICTED_TITLES = Object.freeze({
  billing_plans: 'Plans and allowances',
});

// The tools a commerce-restricted platform runs itself (see backend
// config/clientCommerce); they are not registered at all on that surface.
const RESTRICTED_HIDDEN_TOOLS = new Set(['billing_purchase', 'billing_subscribe']);

const RESTRICTED_PLANS_CAVEAT =
  'Show dVeracity plans, what each plan includes and the free-tier allowance (free, anonymous). ' +
  'Call this before a metered tool so you know which plan fits.';

/**
 * Remove price and checkout guidance from the existing caveat prose. The
 * caveats that survive are the ones a restricted client still needs: scopes,
 * plan gating in neutral terms, and what a refusal means.
 */
function restrictedCaveat(name, caveat) {
  if (name === 'billing_plans') return RESTRICTED_PLANS_CAVEAT;
  return caveat
    .replace(
      'On payment_required, follow offers[] or show checkoutUrl; do not retry the same call.',
      'On payment_required, tell your operator what the call needs; do not retry the same call.'
    )
    .replace(' Costs API credits per call.', '')
    .replace('Costs API credits per call. ', '')
    .replace(/Paid plans only; /g, '');
}

export function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(err) {
  const lines = [err.message];
  if (err instanceof SemanticApiError && err.actionable) lines.push('', err.actionable);
  return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
}

/**
 * Register every dVeracity MCP tool on the given server, each with a top-level title.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {import('./client.js').SemanticClient} client
 * @param {{commerceRestricted?: boolean}} [options]  commerceRestricted drops the
 *        checkout tools and every price mention for a platform that runs
 *        commerce itself
 */
/*
 * Every tool carries MCP tool annotations. The connector directories require
 * them -- Claude's rejects a submission where any tool lacks a read-only or
 * destructive hint, and ChatGPT's requires them configured on the server, not
 * described in the form.
 *
 * All of them are read-only and non-destructive except compliance_evaluate,
 * which executes an approved policy and stores an audit record. Every tool
 * reads from the dVeracity API and none changes or deletes anything the caller
 * already owns. Metered tools (semantic_query, validate_data, ofp_validate,
 * compliance_evaluate) spend credits, which is a billing event; the metered
 * read tools keep readOnlyHint but are not marked idempotent -- the same call
 * twice costs twice. keri_identity mints a session, so it is not idempotent
 * either. openWorldHint is false throughout: every tool talks to one known API.
 */
export function registerTools(server, client, options = {}) {
  const commerceRestricted = options.commerceRestricted === true;
  const definitions = [];
  // Every tool is registered from an explicit *strict* Zod object schema. Two
  // things #11 needs fall out of that, both verified against SDK 1.30:
  //
  //   1. Unknown arguments are REJECTED instead of silently stripped. A raw
  //      shape becomes a non-strict object, so a mistyped key just vanished:
  //      ofp_search_entities {"query": ...} was stripped to {} and returned the
  //      same 100 results as no argument at all -- inverting the answer for an
  //      LLM caller that cannot notice. `.strict()` makes the SDK answer with
  //      isError and a message that names the offending key.
  //   2. Every published inputSchema carries `additionalProperties: false`,
  //      including the no-argument tools whose empty raw shape used to omit
  //      it, so the contract advertised in tools/list is the one enforced.
  //
  // registerTool (not the positional tool() overload) is used because it takes a
  // full ZodObject -- which is where `.strict()` lives -- and accepts the
  // top-level `title` the Claude Connectors portal requires directly, so title no
  // longer needs a post-registration update().
  //
  // `_meta.pricing` is part of every definition so a catalogue read is enough
  // to know what a call costs. The hosted endpoint replaces this value with the
  // billing deployment's own numbers at registration time.
  const tool = (name, caveat, shape, annotations, handler) => {
    if (commerceRestricted && RESTRICTED_HIDDEN_TOOLS.has(name)) return undefined;
    const title = (commerceRestricted && RESTRICTED_TITLES[name]) || TOOL_TITLES[name] || name;
    const lead = (commerceRestricted ? RESTRICTED_LEADS : TOOL_LEADS)[name] || '';
    const caveatText = commerceRestricted ? restrictedCaveat(name, caveat) : caveat;
    const description = caveatText ? `${lead}\n\n${caveatText}` : lead;
    const inputSchema = z.object(shape).strict();
    const securitySchemes = securitySchemesForTool(name);
    // The directory enforces a token budget on tools/list, so metadata is
    // advertised once: title at the top level (not repeated in annotations),
    // securitySchemes at the top level (not repeated in _meta), and no JSON
    // Schema dialect declaration on each inputSchema.
    const { title: _annotationTitle, ...annotationHints } = annotations;
    const { $schema: _schemaDialect, ...publishedSchema } =
      zodToJsonSchema(inputSchema, { $refStrategy: 'none' });
    const definition = {
      name, title, description, annotations: annotationHints,
      inputSchema: publishedSchema,
      securitySchemes,
      _meta: { pricing: pricingForTool(name) },
    };
    definitions.push(definition);
    return server.registerTool(
      name,
      { ...definition, inputSchema },
      handler
    );
  };

  tool(
    'semantic_query',
    'On payment_required, follow offers[] or show checkoutUrl; do not retry the same call.',
    {
      query: z.string().min(1).max(2000),
      sessionId: z.string().optional(),
    },
    { title: 'semantic_query', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async ({ query, sessionId }) => {
      try {
        return textResult(await client.query(query, sessionId));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  tool(
    'semantic_templates',
    '',
    {},
    { title: 'semantic_templates', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async () => {
      try {
        return textResult(await client.templates());
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  tool(
    'credits_balance',
    '',
    {},
    { title: 'credits_balance', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async () => {
      try {
        return textResult(await client.credits());
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  tool(
    'list_standards',
    '',
    {},
    { title: 'list_standards', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async () => {
      try {
        return textResult(await client.standards());
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  tool(
    'validate_data',
    'Only masterData or referenceData.',
    {
      standard: z.string(),
      version: z.string().optional(),
      entityType: z.string().optional(),
      schemaCategory: z.enum(['masterData', 'referenceData']).optional(),
      data: z.record(z.any()),
    },
    { title: 'validate_data', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        return textResult(await client.validate(args));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  tool(
    'keri_identity',
    '',
    {},
    { title: 'keri_identity', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async () => {
      try {
        if (!client.keriEnabled()) {
          return textResult({
            keri: 'not configured',
            how: 'Set DVERACITY_KERI_AID and DVERACITY_KERI_PRESENTATION (path to the agent\'s ' +
              'Agent Authorization credential as self-contained CESR) to enable verified-agent identity.',
          });
        }
        const s = await client.ensureKeriSession();
        return textResult({
          aid: s.aid,
          lei: s.lei,
          scopes: s.scopes,
          credentialSaid: s.credentialSaid,
          sessionExpiresAt: new Date(s.expiresAt).toISOString(),
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ── Open Footprint canonical model ─────────────────────────────────────
  // Design-time tools. All free: reading the standard is what lets an agent
  // build on it correctly, and only the check at the end is metered.

  tool(
    'ofp_models',
    'The response summary carries the served counts.',
    {},
    { title: 'ofp_models', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async () => {
      try {
        return textResult(await client.ofpModels());
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  tool(
    'ofp_search_entities',
    'Matches names, descriptions and fields; ofp_entity gives the full definition.',
    {
      q: z.string().min(1).max(200).optional(),
      domain: z.string().max(100).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    { title: 'ofp_search_entities', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ q, domain, limit }) => {
      try {
        return textResult(await client.ofpEntities({ q, domain, limit }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  tool(
    'ofp_entity',
    'Pass domain when known: ambiguous names fail rather than resolve ' +
      '(ofp_models: ambiguousNameCount).',
    {
      name: z.string().min(1).max(200),
      domain: z.string().max(100).optional(),
    },
    { title: 'ofp_entity', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ name, domain }) => {
      try {
        return textResult(await client.ofpEntity(name, domain));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  tool(
    'ofp_sectors',
    'implemented means a reference implementation exists; planned/placeholder: nothing ' +
      'published.',
    {
      axis: z
        .enum(['esrs', 'sics', 'none'])
        .optional(),
    },
    { title: 'ofp_sectors', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ axis }) => {
      try {
        return textResult(await client.ofpSectors(axis));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  tool(
    'ofp_sector',
    '',
    {
      id: z.string().min(1).max(100),
    },
    { title: 'ofp_sector', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ id }) => {
      try {
        return textResult(await client.ofpSector(id));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  tool(
    'ofp_policies',
    'inputs lists e-ledger fields policies read (e.g. co2e_kg), not canonical names. ' +
      'published:false means no rules; never invent guardrails.',
    {
      id: z.string().min(1).max(100),
    },
    { title: 'ofp_policies', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ id }) => {
      try {
        return textResult(await client.ofpPolicies(id));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  tool(
    'compliance_policies',
    'Only APPROVED policies appear. Empty means none published, not no obligations; ' +
      'never invent rules. Requires compliance:read.',
    {
      framework: z.string().min(1).max(100).optional(),
      domain: z.string().min(1).max(100).optional(),
      include_retired: z.boolean().optional(),
    },
    { title: 'compliance_policies', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ framework, domain, include_retired }) => {
      try {
        return textResult(await client.compliancePolicies({ framework, domain, includeRetired: include_retired }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  tool(
    'compliance_policy',
    'Rego only when the source was retained; else rego_unavailable: source_not_retained, the ' +
      'engine cannot load it, and enforcement says whether structured rules run. ' +
      'Never reconstruct Rego. Requires compliance:read.',
    {
      id: z.string().uuid(),
    },
    { title: 'compliance_policy', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ id }) => {
      try {
        return textResult(await client.compliancePolicy(id));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  tool(
    'compliance_evaluate',
    'Runs regulation-derived Rego, not the generic OFP validator. Decision: passed, denied, ' +
      'unevaluable, not_applicable or error (a refusal, never compliance; error.code: ' +
      'policy_not_release_eligible, policy_no_rendered_checks, policy_no_faithful_checks, ' +
      'policy_coverage_inconsistent). A pass covers ' +
      'only the encoded checks: read coverage.note. Requires the compliance:evaluate scope; calls ' +
      'count against the plan limit. CBAM: entity_type cbam_declaration (default carbon_measure), ' +
      'declaration + lines.',
    {
      policy_id: z.string().uuid(),
      entity_type: z
        .string()
        .min(1)
        .max(50)
        .optional(),
      entity: z.record(z.any()).optional(),
      declaration: z.record(z.any()).optional(),
      lines: z.array(z.record(z.any())).max(500).optional(),
      context: z.record(z.any()).optional(),
      evidence: z
        .array(z.record(z.any()))
        .max(50)
        .optional(),
    },
    { title: 'compliance_evaluate', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        return textResult(await client.complianceEvaluate(args));
      } catch (err) {
        // A 422 is an error DECISION, persisted and readable: show its body so
        // the agent sees policy_hash_mismatch / policy_no_checks, not a bare
        // transport error it might retry.
        if (err instanceof SemanticApiError && err.status === 422 && err.detail) {
          return { content: [{ type: 'text', text: JSON.stringify(err.detail, null, 2) }], isError: true };
        }
        return errorResult(err);
      }
    }
  );

  tool(
    'compliance_evaluation',
    'Readable only by the caller who ran it. Requires compliance:read.',
    {
      evaluation_id: z.string().uuid(),
    },
    { title: 'compliance_evaluation', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ evaluation_id }) => {
      try {
        return textResult(await client.complianceEvaluation(evaluation_id));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  tool(
    'compliance_policy_register',
    'Encoded vs excluded provisions: a pass says nothing about excluded ones. ' +
      'Requires compliance:read.',
    {
      id: z.string().uuid(),
    },
    { title: 'compliance_policy_register', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ id }) => {
      try {
        return textResult(await client.compliancePolicyRegister(id));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  tool(
    'ofp_validate',
    'Checks structure, constraints, enums and calculations; with a sector, its ' +
      'guardrails. Per call read `checked`, `checks_not_run` and ' +
      '`schema.coverage.constraintsDeclared`. Not checked: undeclared ranges, unit coherence, ' +
      'referential integrity, factor provenance. Compliant only if sector_policy is in `checked` ' +
      'and policy.outcome is passed. `schemaValid` is structural; `valid` is deprecated.',
    {
      entity: z.string().min(1).max(200),
      domain: z.string().max(100).optional(),
      payload: z.record(z.any()),
      sector: z.string().max(100).optional(),
      entityType: z
        .string()
        .max(100)
        .optional(),
    },
    { title: 'ofp_validate', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async ({ entity, domain, payload, sector, entityType }) => {
      try {
        return textResult(await client.ofpValidate({ entity, domain, payload, sector, entityType }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  tool(
    'ofp_semantics',
    'High fieldCount is generic; pass maxFieldCount (start at 10) to see only precise codes.',
    {
      maxFieldCount: z.number().int().min(1).max(1000).optional(),
    },
    { title: 'ofp_semantics', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ maxFieldCount }) => {
      try {
        return textResult(await client.ofpSemantics(maxFieldCount));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  tool(
    'ofp_semantic_code',
    'Codes on many fields are generic; aligning to one asserts less ' +
      'than it appears.',
    {
      code: z.string().min(1).max(120),
    },
    { title: 'ofp_semantic_code', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ code }) => {
      try {
        return textResult(await client.ofpSemanticCode(code));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  tool(
    'ofp_model_provenance',
    '',
    {},
    { title: 'ofp_model_provenance', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async () => {
      try {
        return textResult(await client.ofpMeta());
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  tool(
    'ofp_units',
    'detail=full is large; prefer summary. Unresolved codes answer 422 with candidates; ' +
      'unambiguous case/notation variants resolve.',
    {
      code: z.string().min(1).max(120).optional(),
      quantity: z.string().min(1).max(100).optional(),
      detail: z.enum(['summary', 'full']).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      offset: z.number().int().min(0).optional(),
    },
    { title: 'ofp_units', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ code, quantity, detail, limit, offset }) => {
      try {
        return textResult(await client.ofpUnits({ code, quantity, detail, limit, offset }));
      } catch (err) {
        // A 422 carries the candidates the agent needs to retry; flattening it
        // into a transport error would hide them.
        if (err instanceof SemanticApiError && err.status === 422 && err.detail) {
          return textResult(err.detail);
        }
        return errorResult(err);
      }
    }
  );

  tool(
    'ofp_convert',
    'Answers {value, unit, provenance}; keep provenance. A 422 refusal is data: error ' +
      '(unresolved_unit, incompatible_dimension, assumption_required, ' +
      'invalid_conversion_parameters) + detail; read it, do not blind-retry. Volume to energy/mass ' +
      'needs a declared assumption (calorificValue or density); the detail names required ' +
      'fields — never invent. dictionary ([name@]version) is a pin; ' +
      'mismatches refuse. Not CO2e.',
    {
      value: z.number().finite(),
      fromUnit: z.string().min(1).max(120),
      toUnit: z.string().min(1).max(120),
      assumption: z.record(z.any()).optional(),
      dictionary: z.string().min(1).max(200).optional(),
    },
    { title: 'ofp_convert', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ value, fromUnit, toUnit, assumption, dictionary }) => {
      try {
        return textResult(await client.ofpConvert({ value, fromUnit, toUnit, assumption, dictionary }));
      } catch (err) {
        // A 422 is the contract's refusal, not a transport failure: its body
        // (error code + detail, e.g. candidates or the missing assumption) is
        // the answer the agent must read and act on. Unlike compliance_evaluate
        // there is no failed audit record — return it as normal result data.
        if (err instanceof SemanticApiError && err.status === 422 && err.detail) {
          return textResult(err.detail);
        }
        return errorResult(err);
      }
    }
  );

  // ── Billing ──────────────────────────────────────────────────────────────
  // Discovery-to-payment without a human copying a key. billing_plans is
  // anonymous on the hosted endpoint; the other three need the caller's
  // identity. Nothing here charges by itself — each purchase returns a
  // checkout URL a human completes.

  tool(
    'billing_plans',
    'Credit packs, per-credit price and free allowance (anonymous).',
    {},
    { title: 'billing_plans', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async () => {
      try {
        return textResult(await client.billingPlans());
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  tool(
    'billing_status',
    'Use it after a 402 to tell your human what is missing.',
    {},
    { title: 'billing_status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async () => {
      try {
        return textResult(await client.billingStatus());
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  tool(
    'billing_purchase',
    'No charge until a human pays; do not retry the metered tool after a 402.',
    {
      offer_id: z.string().max(64).optional(),
      credit_pack: z.enum(['1000', '5000', '10000']).optional(),
    },
    { title: 'billing_purchase', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async ({ offer_id, credit_pack }) => {
      try {
        return textResult(await client.billingPurchase({ offer_id, credit_pack }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  tool(
    'billing_subscribe',
    'Recurring charges need human approval; never complete the checkout yourself.',
    {
      plan: z.enum(['api', 'enterprise']),
    },
    { title: 'billing_subscribe', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async ({ plan }) => {
      try {
        return textResult(await client.billingSubscribe(plan));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // The SDK's default catalogue drops top-level securitySchemes.
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));
}
