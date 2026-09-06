/**
 * Shared tool registration for the dVeracity Semantic MCP server.
 *
 * Extracted from index.js so the same 16 tool definitions serve both
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
import { SemanticApiError } from './client.js';

export function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(err) {
  const lines = [err.message];
  if (err instanceof SemanticApiError && err.actionable) lines.push('', err.actionable);
  return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
}

/**
 * Register all 16 dVeracity MCP tools on the given server.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {import('./client.js').SemanticClient} client
 */
export function registerTools(server, client) {
  server.tool(
    'semantic_query',
    'Ask a natural-language question about verified emissions data (Open Footprint / PPDM / ' +
      'OGMP-methane knowledge graphs). Costs API credits per call; a payment-required error ' +
      'means the human operator must top up credits. Prefer specific questions (a site, a ' +
      'company, a time range) over broad ones.',
    {
      query: z.string().min(1).max(2000).describe('The natural-language question'),
      sessionId: z.string().optional().describe('Optional session id to continue a conversation'),
    },
    async ({ query, sessionId }) => {
      try {
        return textResult(await client.query(query, sessionId));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'semantic_templates',
    'List the query templates the semantic layer supports (free). Useful to learn what kinds ' +
      'of questions the knowledge graph can answer before spending credits on semantic_query.',
    {},
    async () => {
      try {
        return textResult(await client.templates());
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'credits_balance',
    'Show the remaining dVeracity API credit balance for this account (free).',
    {},
    async () => {
      try {
        return textResult(await client.credits());
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'list_standards',
    'List the sustainability data standards dVeracity can validate against (free).',
    {},
    async () => {
      try {
        return textResult(await client.standards());
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'validate_data',
    'Validate a data payload against a supported sustainability standard (Validation-as-a-' +
      'Service). Costs API credits per call. Use list_standards first to see supported ' +
      'standards and versions.',
    {
      standard: z.string().describe('Standard id, e.g. from list_standards'),
      version: z.string().optional().describe('Standard version'),
      entityType: z.string().optional().describe('Entity type within the standard'),
      schemaCategory: z.string().optional().describe('Schema category within the standard'),
      data: z.record(z.any()).describe('The data payload to validate'),
    },
    async (args) => {
      try {
        return textResult(await client.validate(args));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'keri_identity',
    'Show this agent\'s verified vLEI identity (agent AID, Legal Entity LEI, authorized ' +
      'scopes) if KERI mode is configured — free. In KERI mode every metered call is ' +
      'attributed to this identity in dVeracity\'s audit trail.',
    {},
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

  server.tool(
    'ofp_models',
    'List the eight Open Footprint canonical model domains and which database dialects have ' +
      'published DDL (free). Start here when building an app on the Open Footprint standard: ' +
      'it tells you what the model covers before you look up individual entities.',
    {},
    async () => {
      try {
        return textResult(await client.ofpModels());
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'ofp_search_entities',
    'Search the 239 canonical Open Footprint entities by concept (free). Matches entity names, ' +
      'descriptions and field names. Use this to find the right entity before fetching its full ' +
      'definition with ofp_entity.',
    {
      q: z.string().min(1).max(200).optional().describe('Search term, e.g. "methane" or "footprint"'),
      domain: z.string().max(100).optional().describe('Restrict to one model domain, e.g. "Product Life Cycle"'),
      limit: z.number().int().min(1).max(500).optional().describe('Maximum results (default 100)'),
    },
    async ({ q, domain, limit }) => {
      try {
        return textResult(await client.ofpEntities({ q, domain, limit }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'ofp_entity',
    'Get one canonical entity in full (free): fields with types and required flags, primary key, ' +
      'relationships, and the physical database table implementing it. Pass `domain` whenever you ' +
      'know it — 48 entity names are defined in more than one domain (Country is in four), and ' +
      'without it the call fails rather than guessing which one you meant.',
    {
      name: z.string().min(1).max(200).describe('Entity name, e.g. "Product Carbon Footprint"'),
      domain: z.string().max(100).optional().describe('Model domain, e.g. "Product Life Cycle"'),
    },
    async ({ name, domain }) => {
      try {
        return textResult(await client.ofpEntity(name, domain));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
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
    async ({ axis }) => {
      try {
        return textResult(await client.ofpSectors(axis));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'ofp_sector',
    'Get one sector in full (free): its classification, status, reference artifacts and nested ' +
      'industries. Use ofp_sectors first to find the sector id.',
    {
      id: z.string().min(1).max(100).describe('Sector id, e.g. "extractives" or "production-processing"'),
    },
    async ({ id }) => {
      try {
        return textResult(await client.ofpSector(id));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'ofp_policies',
    'Get a sector\'s policy guardrails as Rego source (free), with policies[].inputs listing the record types and input fields each policy reads — e-ledger fields such as co2e_kg and direction, not canonical Open Footprint field names; a payload without them is reported unevaluable by ofp_validate. When a sector has no published ' +
      'guardrails this returns published:false with a reason — that is a real answer, not an ' +
      'error. Treat it as "no rules are published", never as "there are no constraints", and do ' +
      'not invent guardrails to fill the gap.',
    {
      id: z.string().min(1).max(100).describe('Sector id, e.g. "extractives"'),
    },
    async ({ id }) => {
      try {
        return textResult(await client.ofpPolicies(id));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'ofp_validate',
    'Check a data payload against the canonical Open Footprint model and, when a sector is named, ' +
      'that sector\'s published guardrails. Costs API credits per call. The response reports four ' +
      'distinct outcomes and never conflates them: guardrails passed, guardrails denied, guardrails do ' +
      'not cover this record type (not_applicable), or guardrails could not be evaluated because the ' +
      'payload lacks the inputs the rules read (unevaluable, with policy.missingInputs — canonical Open ' +
      'Footprint entities do not carry the e-ledger fields such as co2e_kg that the rules test). ' +
      'schema.coverage says which declared constraints were enforced and which the model does not ' +
      'declare (it declares no numeric ranges). If policy.ran is false or the outcome is unevaluable, ' +
      'do not report the payload as compliant — valid is null in that case.',
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
    async ({ entity, domain, payload, sector, entityType }) => {
      try {
        return textResult(await client.ofpValidate({ entity, domain, payload, sector, entityType }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
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
    async ({ maxFieldCount }) => {
      try {
        return textResult(await client.ofpSemantics(maxFieldCount));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'ofp_semantic_code',
    'Show which canonical fields carry one O-DEF semantic code (free). This is the reverse ' +
      'lookup a connector needs: given a field in a source system, find where in the Open ' +
      'Footprint model it belongs. Codes carried by more than ten fields are returned with an ' +
      'explicit caution — they are generic classifications, and aligning to one asserts far ' +
      'less than it appears to.',
    {
      code: z.string().min(1).max(120).describe('O-DEF code, e.g. "ofp-sustainability:5.1_3.1"'),
    },
    async ({ code }) => {
      try {
        return textResult(await client.ofpSemanticCode(code));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    'ofp_model_provenance',
    'Show which snapshot of the Open Footprint standard this deployment serves (free): source ' +
      'commit, date, and entity/sector counts. Use it when you need to know how current the model ' +
      'you are designing against is.',
    {},
    async () => {
      try {
        return textResult(await client.ofpMeta());
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
