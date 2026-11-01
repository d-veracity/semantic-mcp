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
export function registerTools(server, client) {
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
  const tool = (name, description, shape, annotations, handler) => {
    const inputSchema = z.object(shape).strict();
    const securitySchemes = securitySchemesForTool(name);
    const definition = {
      name, title: name, description, annotations,
      inputSchema: zodToJsonSchema(inputSchema, { $refStrategy: 'none' }),
      securitySchemes,
      _meta: { securitySchemes, pricing: pricingForTool(name) },
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
    'Ask a natural-language question about verified emissions data (Open Footprint / PPDM / ' +
      'OGMP-methane knowledge graphs). Costs API credits per call; on payment_required, follow ' +
      'offers[] or show checkoutUrl to your operator — do not retry the same call. Prefer ' +
      'specific questions (a site, a company, a time range) over broad ones.',
    {
      query: z.string().min(1).max(2000).describe('The natural-language question'),
      sessionId: z.string().optional().describe('Optional session id to continue a conversation'),
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
    'List the query templates the semantic layer supports (free). Useful to learn what kinds ' +
      'of questions the knowledge graph can answer before spending credits on semantic_query.',
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
    'Show the remaining dVeracity API credit balance for this account (free).',
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
    'List the sustainability data standards dVeracity can validate against (free).',
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
    'Validate a data payload against a supported sustainability standard (Validation-as-a-' +
      'Service). Costs API credits per call. Use list_standards first to see supported ' +
      'standards and versions.',
    {
      standard: z.string().describe('Standard id, e.g. from list_standards'),
      version: z.string().optional().describe('Standard version'),
      entityType: z.string().optional().describe('Entity type within the standard'),
      schemaCategory: z.enum(['masterData', 'referenceData']).optional().describe(
        'Schema category within the standard: "masterData" (default) or "referenceData". ' +
        'Only these two are served; other spellings such as "reference-data" fail to resolve.'
      ),
      data: z.record(z.any()).describe('The data payload to validate'),
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
    'Show this agent\'s verified vLEI identity (agent AID, Legal Entity LEI, authorized ' +
      'scopes) if KERI mode is configured — free. In KERI mode every metered call is ' +
      'attributed to this identity in dVeracity\'s audit trail.',
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
    'List the Open Footprint canonical model domains and which database dialects have ' +
      'published DDL (free). Start here when building an app on the Open Footprint standard: ' +
      'it tells you what the model covers before you look up individual entities. The response ' +
      'summary carries the served counts (domains, entities, fields); they follow the vendored ' +
      'snapshot, which ofp_model_provenance identifies.',
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
    'Search the canonical Open Footprint entities by concept (free). Matches entity names, ' +
      'descriptions and field names. Use this to find the right entity before fetching its full ' +
      'definition with ofp_entity.',
    {
      q: z.string().min(1).max(200).optional().describe('Search term, e.g. "methane" or "footprint"'),
      domain: z.string().max(100).optional().describe('Restrict to one model domain, e.g. "Product Life Cycle"'),
      limit: z.number().int().min(1).max(500).optional().describe('Maximum results (default 100)'),
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
    'Get one canonical entity in full (free): fields with types and required flags, primary key, ' +
      'relationships, and the physical database table implementing it. Pass `domain` whenever you ' +
      'know it — many entity names are defined in more than one domain (Country is in four; the ' +
      'ofp_models summary reports the current count as ambiguousNameCount), and without it the call ' +
      'fails rather than guessing which one you meant.',
    {
      name: z.string().min(1).max(200).describe('Entity name, e.g. "Product Carbon Footprint"'),
      domain: z.string().max(100).optional().describe('Model domain, e.g. "Product Life Cycle"'),
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
    'List industry sectors and their reference implementations (free). Each carries a status: ' +
      '"implemented" means a reference implementation exists, while "planned" or "placeholder" ' +
      'mean the sector is named in the taxonomy but nothing is published for it. Check the status ' +
      'before assuming a sector has content.',
    {
      axis: z
        .enum(['esrs', 'sics', 'none'])
        .optional()
        .describe('Filter by classification axis: esrs (reporting groups) or sics (implementations)'),
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
    'Get one sector in full (free): its classification, status, reference artifacts and nested ' +
      'industries. Use ofp_sectors first to find the sector id.',
    {
      id: z.string().min(1).max(100).describe('Sector id, e.g. "extractives" or "production-processing"'),
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
    'Get a sector\'s policy guardrails as Rego source (free), with policies[].inputs listing the record types and input fields each policy reads — e-ledger fields such as co2e_kg and direction, not canonical Open Footprint field names; a payload without them is reported unevaluable by ofp_validate. When a sector has no published ' +
      'guardrails this returns published:false with a reason — that is a real answer, not an ' +
      'error. Treat it as "no rules are published", never as "there are no constraints", and do ' +
      'not invent guardrails to fill the gap.',
    {
      id: z.string().min(1).max(100).describe('Sector id, e.g. "extractives"'),
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
    'List APPROVED regulatory compliance policies — rules AI-extracted from a regulation (for example ' +
      'EU Green Bonds, CSRD/ESRS) and approved by a dVeracity admin. This is the regulation-derived ' +
      'corpus; the Open Footprint sector guardrails from ofp_policies cite no regulation by design. ' +
      'Requires the VaaS plan or higher (VaaS, API or Enterprise); an Explorer account gets a 403 ' +
      'naming requiredTier, not data. ' +
      'Requires the compliance:read scope — a connector authorised before that scope existed must be ' +
      're-authorised. Returns name, framework, domain, effective dates, the source regulation document, ' +
      'rule count and approval time per policy. Drafts and rejected policies are never returned. An empty ' +
      'list is a real answer (published:false with a reason): treat it as "none published", never as ' +
      '"no obligations exist", and do not invent rules to fill the gap.',
    {
      framework: z.string().min(1).max(100).optional().describe('Regulatory framework, e.g. "CSRD"'),
      domain: z.string().min(1).max(100).optional().describe('Verification domain, e.g. "carbon_measure"'),
      include_retired: z.boolean().optional().describe('Also list retired (superseded) policies'),
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
    'One APPROVED regulatory compliance policy in full: its Rego source, the structured rules the ' +
      'extractor produced, the record types and input fields the Rego reads, and provenance (source ' +
      'regulation document, extraction model and confidence, approval time, policy hash). Paid plans ' +
      'only; requires the compliance:read scope. A draft id — or a row that never went through approval, ' +
      'such as a retired seeded stub — answers "not found" exactly like an unknown id. A policy approved before its source was retained is returned without Rego and says so ' +
      '(rego_unavailable: source_not_retained). Such a policy is NOT loaded into the policy engine; the ' +
      'response says in `enforcement` whether its structured validation rules are still evaluated. ' +
      'Do not reconstruct the Rego yourself.',
    {
      id: z.string().uuid().describe('Policy id from compliance_policies'),
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
    'Execute one named APPROVED compliance policy against one record and return the decision, the ' +
      'per-check results, the inputs the record lacked, remediation, the policy version and hash that ' +
      'decided, and the policy coverage. This runs that policy\'s regulation-derived Rego — not the ' +
      'generic OFP validator and not a fan-out over frameworks. Paid plans only; requires the ' +
      'compliance:evaluate scope, and every call counts against the plan limit. The decision is one of ' +
      'passed, denied, unevaluable (the record lacks inputs a check needs — supply them and retry), ' +
      'not_applicable (the CN code is outside Annex I) or error. An error is a refusal before a verdict: ' +
      'error.code names it, including policy_not_release_eligible, policy_no_rendered_checks, ' +
      'policy_no_faithful_checks, policy_coverage_inconsistent, policy_hash_mismatch and ' +
      'policy_hash_unverified. Do not treat an error as compliant. ' +
      'allow is true only for passed. The decision is the worst of the policy, data and evidence layers, and ' +
      'decision_basis.decided_by names the layer(s) that produced it: a policy whose checks all passed can ' +
      'still be denied by a data finding. A pass means the encoded checks passed: read coverage.note for ' +
      'the provisions the policy does not encode. Per-check outcome may be not_applicable when the ' +
      'check\'s trigger did not hold; that is not a met obligation. The result is stored as an audit ' +
      'record; retrieve it with compliance_evaluation. ' +
      'An annual CBAM declaration is evaluated by setting entity_type to "cbam_declaration" and sending ' +
      'declaration + lines instead of entity: every line runs through the record layers against the ' +
      'carbon_measure record it points at (record_id), then the declaration layer checks the de minimis ' +
      '(Reg (EU) 2023/956 Art 2a / Annex VII), the Art 6(1) 30 September deadline, the annual total, each ' +
      'line\'s quantity against its linked imports, the import year and duplicate customs references. Its ' +
      'decision is the worst line decision combined with the declaration findings, and the per-line ' +
      'results are stored in the same audit record with their record ids.',
    {
      policy_id: z.string().uuid().describe('Approved policy id from compliance_policies'),
      entity_type: z
        .string()
        .min(1)
        .max(50)
        .optional()
        .describe('Record type; defaults to carbon_measure, which is what the CBAM calculation policy evaluates. Use cbam_declaration for an annual declaration (send declaration + lines, not entity)'),
      entity: z
        .record(z.any())
        .optional()
        .describe('The record to evaluate (omit for a cbam_declaration). CBAM fields include cn_code, aggregated_goods_category, quantity_value, quantity_unit, specific_direct_embedded_emissions, installation_country_id, production_route, period_start and period_end (the reporting period; the typed reporting_period_start/reporting_period_end pair is also accepted)'),
      declaration: z
        .record(z.any())
        .optional()
        .describe('For entity_type "cbam_declaration": the annual declaration — declaration_id, authorised_declarant_id, reporting_year, submitted_date, status, free_allocation_adjustment_tco2e, carbon_price_reduction_tco2e, certificates_to_surrender, total_embedded_emissions_tco2e and declarant {eori_number, authorisation_status, cbam_account_number}'),
      lines: z
        .array(z.record(z.any()))
        .max(500)
        .optional()
        .describe('For entity_type "cbam_declaration": the declaration lines. Each carries declaration_line_id, record_id (the carbon_measure record it summarises), cn_code, country_of_origin_id, installation_id, total_quantity, unit, total_embedded_emissions_tco2e, specific_embedded_emissions, emissions_basis, verification_report_id, customs_declaration_reference, imports[{import_id, customs_declaration_reference, import_date, cn_code, net_mass_t, ...}], entity, context and evidence'),
      context: z.record(z.any()).optional().describe('Evaluation context passed to the policy'),
      evidence: z
        .array(z.record(z.any()))
        .max(50)
        .optional()
        .describe(
          'Evidence references: {kind, ref, sha256, period_start?, period_end?, installation_id?, payload?}. ' +
            'Kinds: installation, production_record, meter, emission_factor, precursor_emissions, verification_report, ' +
            'carbon_price_payment. A carbon_price_payment payload documents the country, price, currency and proof of ' +
            'payment and names an independent certifier (Reg (EU) 2023/956 Art 9(2)). ' +
            'sha256 is 64 hex characters; anything else is refused.'
        ),
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
    'Retrieve one stored compliance evaluation by id — the audit record compliance_evaluate wrote. ' +
      'Only the caller who ran it can read it; another account\'s id answers "not found" exactly like ' +
      'an unknown one. Paid plans only; requires the compliance:read scope. Returns the decision, the ' +
      'stored result (per-check outcomes, missing inputs, remediation, policy version and hash), the ' +
      'evidence references and the input hash.',
    {
      evaluation_id: z.string().uuid().describe('evaluation_id returned by compliance_evaluate'),
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
    'The published release register of one APPROVED compliance policy: every extracted provision with its ' +
      'legal reference, review verdict and disposition, the treatment rendered in the Rego (or why it was ' +
      'excluded), its status (enforced, attested, unsupported or informational), the fields it needs, and ' +
      'the approved hash, version and effective date. Use it to see what an evaluation actually covers and ' +
      'which provisions are NOT encoded — a pass on the encoded checks is not compliance with the excluded ' +
      'provisions. Paid plans only; requires the compliance:read scope.',
    {
      id: z.string().uuid().describe('Approved policy id from compliance_policies'),
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
    'Check a data payload against the canonical Open Footprint model and, when a sector is named, ' +
      'that sector\'s published Rego guardrails. Costs API credits per call. WHAT IT CHECKS: structure ' +
      '(required fields, primary key, declared types); the constraints the model declares (identifier ' +
      'patterns, enums, date formats, lengths); value ranges where the model declares a bound (a ' +
      'quantity outside the declared minimum or maximum is rejected; how many fields declare a bound ' +
      'moves with the vendored snapshot, so this check runs on some entities and not others — read ' +
      '`checked` and `schema.coverage.constraintsDeclared` on each response rather than assuming it ' +
      'ran); temporal consistency (a validity period whose end precedes its start is rejected); enum ' +
      'membership (a foreign key into a vocabulary that publishes its members is checked against that ' +
      'member set, so a well-formed identifier for a referent that does not exist is caught); ' +
      'calculation reproducibility (where the record carries a quantity, an emission factor value and ' +
      'a stated CO2e result, quantity × factor = result is reproduced within 1% and a record that ' +
      'contradicts itself is rejected; this tests arithmetic only — a self-consistent record is not ' +
      'thereby a correct one, because whether the factor suits this source and period is factor ' +
      'provenance and whether the quantity came from the meter it claims needs the data plane, and ' +
      'neither is checked); and, ' +
      'with a sector, the guardrails. WHAT IT DOES NOT CHECK in this release: value ranges on fields ' +
      'whose model declares no bound (an out-of-range quantity passes, reported per call as ' +
      'no_range_declared or no_numeric_fields), unit coherence, ' +
      'referential integrity (foreign keys are pattern-checked and, where a vocabulary publishes one, ' +
      'member-checked, but never resolved against live records), factor provenance, or materiality. ' +
      'The response says so per call: `checked` lists the checks that ran and `checks_not_run` lists ' +
      'every catalogued check that did not, each with a machine-readable `reason` and a `detail` ' +
      'explaining the gap. That reason vocabulary belongs to the validator and grows with it, so read ' +
      'the `reason` off the response rather than matching it against a fixed list. `schemaValid` is ' +
      'the structural verdict; `assuranceLevel` ' +
      '(schema-only | schema-and-value | schema-value-and-policy | full) is the depth earned. `valid` ' +
      'is deprecated (kept through 0.5.x, removed no earlier than 0.6.0) — it only ever covered the ' +
      'checks that ran. Every violation and warning carries severity (error | warning). Unknown fields ' +
      'are warnings, never violations, and each carries `didYouMean` candidates when the model has a ' +
      'plausible match; `schema.normalisations` discloses keys that resolved only through case and ' +
      'separator folding. `advisories` carries findings that are true of the payload but do not bear on ' +
      'its validity: today `deprecated_field`, severity warning, naming a `successor` when the model ' +
      'names one — an advisory never changes `schemaValid`. Guardrails report four distinct outcomes, ' +
      'never conflated: passed, denied, not_applicable (the rules do not cover this record type), or ' +
      'unevaluable (the payload lacks the e-ledger inputs the rules read, e.g. co2e_kg — listed in ' +
      'policy.missingInputs). Never report a payload as compliant unless sector_policy is in `checked` ' +
      'and policy.outcome is passed.',
    {
      entity: z.string().min(1).max(200).describe('Canonical entity name, e.g. "Product Carbon Footprint"'),
      domain: z.string().max(100).optional().describe('Model domain; required when the entity name is ambiguous'),
      payload: z.record(z.any()).describe('The instance to check, as an object'),
      sector: z.string().max(100).optional().describe('Sector id to apply guardrails from, e.g. "extractives"'),
      entityType: z
        .string()
        .max(100)
        .optional()
        .describe(
          'The record type the guardrails discriminate on, e.g. "directEmission". Without it the ' +
            'entity name is used, which usually matches nothing — the response then reports ' +
            'policy.outcome "not_applicable" and lists the types the rules do cover.'
        ),
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
    'List the O-DEF semantic codes carried by the canonical model (free). Use this when ' +
      'mapping fields from another system — SAP, an ERP, a supplier feed — onto Open Footprint: ' +
      'a code is the shared address two systems can align on. Every code comes with fieldCount, ' +
      'the number of canonical fields sharing it. A high count means a generic fallback that ' +
      'asserts almost nothing, so pass maxFieldCount (10 is a good start) to get only codes ' +
      'specific enough to be a real alignment target.',
    {
      maxFieldCount: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe('Only return codes carried by at most this many fields'),
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
    'Show which canonical fields carry one O-DEF semantic code (free). This is the reverse ' +
      'lookup a connector needs: given a field in a source system, find where in the Open ' +
      'Footprint model it belongs. Codes carried by more than ten fields are returned with an ' +
      'explicit caution — they are generic classifications, and aligning to one asserts far ' +
      'less than it appears to.',
    {
      code: z.string().min(1).max(120).describe('O-DEF code, e.g. "ofp-sustainability:9.102_1.102" (registry v3.0.0 numbers plugin extensions in the O-DEF 100-series)'),
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
    'Show which snapshot of the Open Footprint standard this deployment serves (free): source ' +
      'commit, date, and entity/sector counts. Use it when you need to know how current the model ' +
      'you are designing against is.',
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

  // ── Billing ──────────────────────────────────────────────────────────────
  // Discovery-to-payment without a human copying a key. billing_plans is
  // anonymous on the hosted endpoint; the other three need the caller's
  // identity. Nothing here charges by itself — each purchase returns a
  // checkout URL a human completes.

  tool(
    'billing_plans',
    'Show dVeracity plans, credit packs, the per-credit price and the free-tier allowance ' +
      '(free, anonymous). Call this before a metered tool so you know what a credit buys and ' +
      'what checkout options you can show your human operator.',
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
    "Show this account's current plan, credit balance and remaining monthly free allowance " +
      '(free). Use it after a 402 to tell your human exactly what is missing.',
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
    'Start a one-time credit purchase and return a checkoutUrl, plus a paymentLink when the ' +
      'deployment configures one. No charge happens until a human completes the payment; show ' +
      'the URL to your operator. Prefer this over retrying the metered tool after a 402.',
    {
      offer_id: z.string().max(64).optional().describe('Offer id from billing_plans, e.g. "credits-1000"'),
      credit_pack: z.enum(['1000', '5000', '10000']).optional().describe('Credit pack size; defaults to the smallest pack'),
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
    'Start a membership subscription checkout and return only the checkoutUrl. Recurring ' +
      'charges always need human approval: do not complete the checkout yourself, and do not ' +
      'retry the metered tool until your operator confirms the plan is active.',
    {
      plan: z.enum(['api', 'enterprise']).describe('Membership plan to subscribe to'),
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
