# Changelog

All notable changes to `@dveracity/semantic-mcp`. The package is a stdio
wrapper over the dVeracity REST API and is also mounted by the backend at
`https://api.dveracity.com/mcp`; a response-shape change is made in the backend
and documented here because this package is where agents read the contract.

## 0.5.4 — 2026-09-08

### Fixed
- Unknown tool arguments are rejected instead of silently stripped. Every tool is
  now registered from `z.object(shape).strict()` via `registerTool`, so a mistyped
  key answers `-32602` naming the key rather than running the tool with `{}` —
  which had inverted answers (`ofp_search_entities {"query": …}` returned the same
  unfiltered listing as no argument) and could misreport a mistyped `sectorId` on
  `ofp_validate` as `no_sector_supplied`, a provenance defect in an assurance chain.
  All 16 published `inputSchema`s now carry `additionalProperties: false`, including
  the four no-argument tools. Top-level `title` is set natively by `registerTool`.
  Ported from d-veracity/semantic-mcp#13 (external QA: #11).

## 0.5.3 — unreleased

Response contract for `ofp_validate` ([semantic-mcp#5](https://github.com/d-veracity/semantic-mcp/issues/5), FR-2 + FR-5).
Absence of a check must never read as a pass.

### Changed

- **`valid` → `schemaValid`.** `schemaValid` is the structural verdict
  (`null` when the structural check could not run). `valid` is **deprecated**:
  it keeps its 0.5.0 meaning unchanged and ships alongside `schemaValid` for the
  rest of the 0.5.x line, with a `deprecations` entry in every response
  (`key: "valid"`, `severity: "warning"`, `replacement: "schemaValid"`,
  `removalNotBefore: "0.6.0"`). Removal no earlier than **0.6.0**. Decided in
  [#1](https://github.com/d-veracity/semantic-mcp/issues/1), option A — no clean break.
- `checked` names the guardrail check `sector_policy` (was `policy`), so the
  same name appears whether it ran or not.

### Added

- `checks_not_run`: every catalogued check that did not run, with a `reason`
  and usually a `detail`. The catalogue is `schema`, `value_range`,
  `unit_coherence`, `temporal_consistency`, `referential_integrity`,
  `factor_provenance`, `materiality`, `sector_policy`; each is in exactly one of
  `checked` / `checks_not_run`. Reasons: `not_implemented`, `no_data_plane`,
  `no_range_declared`, `no_numeric_fields`, `schema_not_run`,
  `no_sector_supplied`, `no_policy_published` (detail names the sector status,
  e.g. `planned`), `not_applicable`, `unevaluable`. This generalises the
  existing `policy.ran` / `reason` / `message` pattern; the policy block itself
  is unchanged.
- `assuranceLevel`: `schema-only` | `schema-and-value` |
  `schema-value-and-policy` | `full`. Each level requires every check beneath
  it to have run. `none` is emitted in the one case outside the four, when the
  structural check itself could not run.
- `severity` on every violation (`error`) and warning (`warning`).
- The `ofp_validate` tool description and README now state what the check does
  and does **not** cover in this release.

### Unchanged

- Every violation rule id and field string from 0.5.0
  (`required_field_missing`, `pattern_mismatch`, `format_mismatch`,
  `type_mismatch`, `primary_key_missing`, `enum_violation`, …).
- `unknown_field` stays a per-field **warning** with its round-trip message
  ([#3](https://github.com/d-veracity/semantic-mcp/issues/3), closed as moot).
- `schema.*`, `policy.*` and `credits_charged`.

## 0.5.2

- Top-level `title` on every tool (Claude Connectors review criteria).

## 0.5.1

- MCP tool annotations on all 16 tools; `repository` points at the public mirror.

## 0.5.0

- Public mirror of `@dveracity/semantic-mcp`.
