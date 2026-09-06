# dVeracity Semantic MCP server

[![smithery badge](https://smithery.ai/badge/ajvdvoort/dveracity)](https://smithery.ai/servers/ajvdvoort/dveracity)

Gives any MCP-capable AI agent (Claude Code, Cursor, custom agents) metered access
to the **dVeracity Semantic API** — natural-language queries over the
verified-emissions knowledge graph (Open Footprint / PPDM / OGMP-methane) — and
**VaaS** standards validation.

## Prerequisites

1. An **api-tier subscription**: https://dveracity.com/pricing
2. An **API key** (`dvrc_…`): `POST /api/v1/api-keys` (or the dashboard)
3. API **credits** for metered calls: `POST /api/v1/vaas/credits/purchase`

The machine-readable service contract lives at `GET /api/v1/semantic/manifest`
(public, no auth).

## Install

From this directory: `npm install`

### Claude Code

```bash
claude mcp add dveracity \
  -e DVERACITY_API_KEY=dvrc_yourkey \
  -- node /path/to/dVE/mcp/semantic-mcp/index.js
```

### Generic MCP JSON config (Cursor, etc.)

```json
{
  "mcpServers": {
    "dveracity": {
      "command": "node",
      "args": ["/path/to/dVE/mcp/semantic-mcp/index.js"],
      "env": { "DVERACITY_API_KEY": "dvrc_yourkey" }
    }
  }
}
```

Optional: `DVERACITY_API_URL` overrides the API base URL (defaults to prod).

### KERI mode — verified agent identity (optional)

If the agent holds a **dVeracity Agent Authorization credential** (an ACDC issued
by its Legal Entity, chained to the Legal Entity's vLEI — see
`elm/docs/VLEI_AGENT_TOKENS_DESIGN.md`), set:

```
DVERACITY_KERI_AID=<the agent's AID (credential issuee)>
DVERACITY_KERI_PRESENTATION=/path/to/agent-credential.cesr   # self-contained CESR
```

The server then authenticates the agent by verifiable presentation
(challenge → exchange → 1-hour session, refreshed transparently) and attaches
`X-Keri-Session` to every call: the API key keeps carrying **billing**, the KERI
session adds **verified identity** — every metered call is attributed to the
agent AID and Legal Entity LEI in dVeracity's audit trail. The `keri_identity`
tool (free) shows the active identity. Scope denials (a credential that doesn't
carry e.g. `semantic:query`) surface as actionable errors naming the carried
scopes. Signify-based nonce signing is a planned enhancement.

## Tools

| Tool | Cost | What it does |
|---|---|---|
| `semantic_query` | credits | Natural-language question over the verified-emissions knowledge graph |
| `semantic_templates` | free | Catalog of supported query templates |
| `credits_balance` | free | Remaining credit balance |
| `list_standards` | free | Standards VaaS can validate against |
| `validate_data` | credits | Validate a payload against a supported standard |
| `keri_identity` | free | This agent's verified vLEI identity, when KERI mode is configured |

### Open Footprint canonical model

Design-time tools for building an application on the Open Footprint standard.
Reading the model is free; only the check at the end is metered.

| Tool | Cost | What it does |
|---|---|---|
| `ofp_models` | free | The eight model domains, and which database dialects have published DDL |
| `ofp_search_entities` | free | Search 239 canonical entities by name, description or field |
| `ofp_entity` | free | One entity in full: fields, types, keys, relationships, physical table |
| `ofp_sectors` | free | Industry sectors, each with a status |
| `ofp_sector` | free | One sector, with its reference artifacts |
| `ofp_policies` | free | A sector's Rego guardrails, or an explicit "none published" |
| `ofp_validate` | credits | Check a payload against the model and, optionally, sector guardrails |
| `ofp_semantics` | free | O-DEF semantic codes, for aligning another system's fields onto the model |
| `ofp_semantic_code` | free | Which canonical fields carry one code — the reverse lookup a connector needs |
| `ofp_model_provenance` | free | Which snapshot of the standard this deployment serves |

Two behaviours are deliberate and worth knowing before you build against them.

**Ambiguous entity names fail rather than resolve.** 48 of the 239 entity names
are defined in more than one domain — `Country` is in four. `ofp_entity` without
a `domain` returns an error listing the candidates instead of picking one. Pass
`domain` whenever you know it.

**Semantic codes vary wildly in usefulness.** 660 of 813 canonical fields carry an
O-DEF code, but the distribution is skewed: one generic code covers 255 fields.
Only about 16% sit on a code shared by ten fields or fewer. Every code is
returned with its `fieldCount` — check it before aligning to one, and pass
`maxFieldCount: 10` to `ofp_semantics` to see only the precise ones.

**"Nothing published" is an answer, not an error.** Most sectors are named in the
taxonomy but have no reference implementation, and only seven publish policy
guardrails. `ofp_policies` on such a sector returns `published: false` with a
reason, and `ofp_validate` reports `policy.ran: false`. Both mean *no rules are
published*, never *there are no constraints* — a payload checked for structure
alone is not a compliant one, and should not be described as one.

A fourth outcome, `unevaluable`, means the sector's rules ran but every rule that came back false reads an input the payload does not carry (`policy.missingInputs`, e.g. `co2e_kg`, `direction`, `counterparty_industry`). Those are e-ledger record fields, not canonical Open Footprint field names — `ofp_policies` lists them per policy under `inputs`. Unevaluable is neither a pass nor a breach, and `valid` is `null`.

## Billing behavior (for agents)

Metered calls return an **HTTP 402** when the account is out of credits. The
server surfaces this as a tool error that tells the agent to ask its **human
operator** to purchase credits or upgrade — agents should relay that message and
stop, not retry.

## Test

`npm test` (no network; the HTTP layer is stubbed).

## Where it is listed

- [Smithery](https://smithery.ai/servers/ajvdvoort/dveracity) — one-click add for Smithery toolbox users
- [Official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=dveracity) — `com.dveracity/semantic-mcp`
- [npm](https://www.npmjs.com/package/@dveracity/semantic-mcp) — `@dveracity/semantic-mcp`
