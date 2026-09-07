# Sealed QA Fixtures — Phase 0

Independent conformance fixtures for `ofp_validate`. Authored by external QA
(Perplexity) against the model source of truth, **not** against the validator's
observed behaviour.

Tracks `d-veracity/semantic-mcp#4`.

---

## Governance

**No implementer writes the regression test for the bug they are fixing.** A test
authored by the agent that fixed the bug will be engineered to pass. These
fixtures are sealed: they land before implementation starts and are changed only
by QA, with a stated reason.

**Expectations derive from the model, not the API.** Every case in fixture 1
carries a `model_basis` field explaining which model declaration implies the
expected outcome. A reviewer can therefore check the fixture against
`openfootprint`, rather than against the thing under test.

**CI is the arbiter.** One coder runs native Ubuntu, one runs WSL. Neither local
environment is evidence.

---

## Baseline — server `0.5.2`, model `6c2d110`, measured 2026-09-07

| Suite | Result |
|---|---|
| Semantic error probe | **2 / 7** detected · 2/2 negative tests pass |
| Key normalisation (regression control) | **24 / 24** already passing |
| Semantic synonym resolution | **0 / 16** |
| Foreign-key controls | **4 / 4** |
| Valid-payload corpus | **8 / 8** clean · **0** false positives |
| Latency | p50 **64.4 ms** – **138.5 ms** across runs (see caveat) |

Every run records the server build in `baseline.json` under `server`. Do not
compare two baselines without checking it — see "Attributing a baseline" below.

### The baseline corrects the PRD in the product's favour

Two capabilities the PRD assumed were missing are already implemented, and the
original audit undercounted because it read only the `violations` array and not
`warnings`.

**Field-name normalisation already works.** All five formatting variants resolve
to the canonical field *and* have its declared constraints applied:

| Supplied key | Resolves to | Constraint applied |
|---|---|---|
| `unit of measure id` | `Unit Of Measure ID` | yes |
| `unit_of_measure_id` | `Unit Of Measure ID` | yes |
| `UNIT_OF_MEASURE_ID` | `Unit Of Measure ID` | yes |
| `UnitOfMeasureID` | `Unit Of Measure ID` | yes |
| `unitOfMeasureId` | `Unit Of Measure ID` | yes |
| `uom` | *(not resolved)* | `unknown_field` warning |

**`unknown_field` already exists** as a warning, with a well-judged message:
*"`uom` is not defined on Emission Statement. It is not rejected, but it is
outside the canonical model."*

**The response is more honest than credited.** It already reports
`coverage.constraintsDeclared` against `coverage.constraintsApplied`, a
`policy.ran: false` block with `reason: "no_sector_supplied"`, and prose notes
such as *"The model declares no numeric range for any of Emission Statement's 1
numeric fields, so negative or out-of-range quantities are not rejected
structurally."*

The product diagnoses its own gap in the response body. FR-2 is therefore
largely a **restructuring** of existing honest content into a machine-readable
`checks_not_run` array, not new disclosure.

### What is genuinely missing

| Gap | Evidence |
|---|---|
| `value_range` | E1 negative quantity undetected; server notes the absent constraint itself |
| `temporal_consistency` | E3 inverted validity period undetected |
| Format check on `Valid From Datetime` | E4 undetected while E5 (its partner) is caught — isolates the model asymmetry as sole cause |
| `enum_membership` | E6 undetected — pattern conformance is checked, referent validity is not |
| `deprecated_field` | E7 undetected across all four deprecated fields |
| `didYouMean` | 0 of 16 semantic synonyms resolved (`uom`, `co2eKg`, `periodStart`, `MENGE`) |

**The real FR-1 gap is semantic synonyms, not formatting.** Formatting is solved.

---

## Fixtures

### `01-semantic-error-probe.json` — 9 cases
One planted impossibility per case, using the **correct canonical field name**.
Includes two controls (E2, E5) that already pass, so a regression is
distinguishable from a gap, and two negative tests (N1 zero quantity, N2 clean
payload) that must never fire.

The E4/E5 pairing is deliberate: identical malformed value, one on each end of
the validity period. E5 is caught, E4 is not. That isolates the model asymmetry
reported in `openfootprint#48` as the sole cause.

### `02-mismapped-key-suite.json` — 44 cases
Tiered so partial credit is meaningful:

| Tier | n | Expected behaviour |
|---|---|---|
| `normalisation` | 24 | Resolve silently, constraints applied. **Already passing — regression control.** |
| `moderate` | 4 | Truncation/typo — warn and suggest |
| `hard` | 10 | Semantic synonym — warn and suggest. **The real gap.** |
| `expert` | 2 | SAP source-system names (`MENGE`, `MEINS`) — aspirational |
| `control` | 4 | Genuinely foreign — warn with **no** suggestion |

Controls matter as much as targets: a suggestion engine that offers a canonical
field for `__etl_batch_id` is worse than one that stays silent.

### `03-valid-payload-corpus.json` — 8 cases
Must produce **zero** violations. Covers zero quantity, single-instant validity
period, high-precision and large magnitudes, unicode and punctuation in free
text, and fractional-offset timezones (`+05:30`).

A new check that breaks these is worse than the gap it closes.

---

## Running

```bash
python3 build_fixtures.py            # regenerate from the model
python3 run_fixtures.py --latency 30 # execute, write baseline.json
```

`build_fixtures.py` reads
`d-veracity/openfootprint :: cicd/generated/entity-index.json`. Regenerate after
any model change so the fixtures track the model rather than drifting from it.

### Credit cost — read before wiring into CI

`ofp_validate` costs **1 credit per call**. Fixture 2 is deliberately batched:
the validator returns every unknown-field warning in one response, so 44 keys
cost **2 credits** rather than 44.

| Suite | Credits |
|---|---|
| Error probe | 9 |
| Mismapped keys (batched) | 2 |
| Valid corpus | 8 |
| Latency sample (n=30) | 30 |
| **Total per full run** | **49** |

At 49 credits a run, per-PR CI on an active repo is material against a 2,000
credit balance. Recommended: full suite on merge to main and nightly; drop
`--latency` on PR runs for a **19-credit** pass.

**This is a product signal, not just an ops note.** If conformance testing
against the paid endpoint is expensive, customers will test less than they
should. Worth considering a free or metered validation tier for CI use.

---

## Known deviations from the issue spec

- **44 mismapping cases, not 50.** Deduplicated — several formatting variants
  collapse to the same key (`Quantity` → `quantity` under three transforms).
  Inflating the count with duplicate keys would misreport coverage.
- **Latency n=30, not 100.** Each call costs a credit. n=30 gives a stable p50;
  raise with `--latency 100` when it matters.
- **Latency is wall clock from the QA sandbox**, including network. Not
  server-side time.

### Latency is too noisy to gate on

Two runs ten minutes apart on the same server build and the same payload:

| Run | p50 | p90 | min | max |
|---|---|---|---|---|
| 16:56 UTC | 64.4 ms | 190.4 ms | — | — |
| 17:10 UTC | 138.5 ms | 249.3 ms | 24.4 ms | 278.1 ms |

The p50 more than doubled with no change to the server. An 11x spread between
min and max within a single run points at cold starts or shared-tenant
variance on the Cloud Run backend, not at validation cost.

**Do not gate on this number.** The regression gate deliberately ignores
latency. Treat it as a coarse trend only, and if a real latency budget is
needed, measure server-side instead.

## Attributing a baseline

A baseline is meaningless without knowing which build produced it. This suite
learned that the hard way: a server version read on 2026-09-05 was compared
against a repo cloned on 2026-09-07, and the two-day gap spanned two releases.
The conclusion drawn — that the deployment was stale — was wrong.

`run_fixtures.py` now issues an MCP `initialize` before any test and records
`serverInfo` in `baseline.json`. It costs no credits. If it cannot be read, the
run prints a warning and the baseline is marked unattributed.

Note that the npm package `@dveracity/semantic-mcp` is a **stdio wrapper** that
calls the REST backend; the remote endpoint at `api.dveracity.com/mcp` is a
separate server-side artifact. They share a version number but are not the same
build. Check `serverInfo` from the endpoint you actually tested.

---

## Model defects surfaced while building these

Reported to `openfootprint#48`:

1. `Valid From Datetime` declares `constraints: null` while its required partner
   `Valid To Datetime` declares `format: date-time`.
2. `Quantity` is `required: false` with `constraints: null`.
3. Four `DEPRECATED` fields marked only in prose inside `description`.

Found while building fixture 3, not yet reported:

4. **`Emission Statement ID` is a `primaryKey` but is absent from
   `requiredFields`** (`required: false`). A payload constructed from
   `requiredFields` alone therefore fails with `primary_key_missing`. Any code
   generator or test harness that trusts `requiredFields` produces invalid
   payloads. V1 encodes this.
