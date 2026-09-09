"""Generate the sealed QA fixture set for Phase 0.

Fixtures are authored from the model source of truth
(d-veracity/openfootprint :: cicd/generated/entity-index.json), NOT from the
validator's own behaviour. Expected outcomes are derived from what the model
declares, so the fixtures remain valid if the validator changes.
"""
import json
import os
import pathlib
import re

# The model source of truth. Overridable so a reviewer can regenerate against a
# specific openfootprint commit without first copying it into /tmp:
#   OFP_ENTITY_INDEX=.../openfootprint/cicd/generated/entity-index.json \
#       python3 build_fixtures.py
OFP = pathlib.Path(
    os.environ.get("OFP_ENTITY_INDEX", "/tmp/ofp/cicd/generated/entity-index.json")
)
OUT = pathlib.Path(__file__).parent / "fixtures"
OUT.mkdir(exist_ok=True)

idx = json.loads(OFP.read_text())
entities = idx["domains"] if isinstance(idx.get("domains"), list) else None

# Flatten entity records regardless of container shape.
def all_entities(d):
    for key in ("entities", "domains"):
        v = d.get(key)
        if isinstance(v, list) and v and isinstance(v[0], dict) and "fields" in v[0]:
            return v
        if isinstance(v, dict):
            out = []
            for dv in v.values():
                if isinstance(dv, dict) and "fields" in dv:
                    out.append(dv)
                elif isinstance(dv, dict):
                    for e in dv.get("entities", []) or []:
                        out.append(e)
                elif isinstance(dv, list):
                    out.extend(x for x in dv if isinstance(x, dict) and "fields" in x)
            if out:
                return out
    raise SystemExit("could not locate entity records")

ENTS = all_entities(idx)
BY_NAME = {}
for e in ENTS:
    BY_NAME.setdefault(e["name"], []).append(e)

ES = [e for e in ENTS if e["name"] == "Emission Statement"][0]
ES_FIELDS = {f["name"]: f for f in ES["fields"]}

# Stands in for a natural key where the vocabulary publishes no members. See
# key_for() for why this is no longer safe everywhere it used to be.
PLACEHOLDER_KEY = "X-001"


def id_for(pattern, key=PLACEHOLDER_KEY):
    """Build a value satisfying a canonical FK pattern."""
    m = re.search(r"([a-z\-]+-data)\\-\\-(\w+)", pattern or "")
    if not m:
        return None
    return f"dveracity:{m.group(1)}--{m.group(2)}:{key}:1"


def key_for(field):
    r"""The natural key to plant in a generated FK id.

    PLACEHOLDER_KEY satisfies the pattern's `.+` key slot and nothing more: the
    declared grammar for a reference-data FK is

        ^[\w\-\.]+:reference-data\-\-<Entity>:.+:[0-9]*$

    so any token is well-formed. openfootprint#50 changed that, by publishing
    each vocabulary's members as `field.referenceMembers = {entity, keys}`.
    Against a published vocabulary the placeholder is now a NON-MEMBER: the id
    is well-formed but its referent does not exist, which is precisely what
    probe E6 asserts. Left as it was, the base payload would be rejected by
    enum_membership and every case built on it — all 9 probes, all 44
    mismapping cases and all 8 valid-corpus payloads — would turn into false
    positives, breaking the regression gate on the valid corpus and firing a
    negative test (N2).

    Where no members are published the placeholder stays, deliberately. Absence
    of `referenceMembers` means the vocabulary is not published, not that any
    referent is acceptable (index `usage.referenceMembers`), so the fixture must
    not invent a member for it. EmissionComponent and UnitOfMeasure are in that
    position today and keep PLACEHOLDER_KEY.

    `keys` is sorted at source, so keys[0] is deterministic across regenerations.
    For EmissionRecordingMethodType that is CALCULATED — a member, and apt for a
    purchased-electricity payload, which is activity data times a factor rather
    than a meter reading. QA may prefer to pin MEASURED, the dominant real key
    (131,922 of the 132,019 deployed statements that carry one); that is a one-line change here and
    nothing else in the suite depends on which member is chosen.
    """
    keys = (field.get("referenceMembers") or {}).get("keys") or []
    return keys[0] if keys else PLACEHOLDER_KEY


BASE = {}
for name, f in ES_FIELDS.items():
    if "DEPRECATED" in (f.get("description") or ""):
        continue
    c = f.get("constraints") or {}
    if c.get("pattern"):
        v = id_for(c["pattern"], key=key_for(f))
        if v:
            BASE[name] = v
    elif name == "Name":
        BASE[name] = "Venue electricity, September 2026"
    elif name == "Quantity":
        BASE[name] = 1250.5
    elif "Datetime" in name:
        BASE[name] = ("2026-09-01T00:00:00Z" if "From" in name
                      else "2026-09-30T23:59:59Z")
    elif name == "Description":
        BASE[name] = "Purchased electricity for the main venue."

# ---------------------------------------------------------------- fixture 1
# Each case states WHY the model implies the expectation, so a reviewer can
# check the fixture against the model rather than against the validator.
probe = {
    "fixture": "semantic-error-probe",
    "entity": "Emission Statement",
    "domain": "common-entities",
    "purpose": (
        "Each case plants exactly one semantically impossible value using the "
        "CORRECT canonical field name. Cases are keyed to PRD acceptance "
        "criteria. Authored independently of the implementation."
    ),
    "base_payload": BASE,
    "cases": [
        # Ported verbatim from the sealed artifact. QA rewrote E1 when Q2 was
        # decided (semantic-mcp#2, 2026-09-07) and replaced `blocked_by` with an
        # explicit accepted-red status, but the generator was never updated, so
        # it had drifted from the file it generates: regenerating silently
        # un-decided E1. This commit changes no fixture byte.
        {"id": "E1", "ac": "AC-3.1", "name": "negative quantity",
         "patch": {"Quantity": -999999},
         "expect_rule": "value_range", "expect_field": "Quantity",
         "model_basis": "Q2 decided 2026-09-07 (#2): removals are POSITIVE "
                        "quantities of a Sink, per ISO 14064-1. No field permits "
                        "negatives. But sign is a consequence of the linked "
                        "activity's Emission Inventory Type, and a single-payload "
                        "validator cannot resolve Emission Statement -> Emission "
                        "Activity -> Emission Inventory Type. Phase 0 therefore "
                        "emits a WARNING, not a violation.",
         "expect_severity": "warning",
         "status": "accepted-red",
         "accepted_red_reason": "Blocked on openfootprint model change: Emission "
                                "Inventory Type ID must become required on "
                                "Emission Activity, then Quantity gains "
                                "minimum:0. Until then this stays red BY "
                                "DECISION. It is not a defect and must not be "
                                "treated as a regression."},
        {"id": "E2", "ac": "AC-1.5b", "name": "invalid unit, canonical key",
         "patch": {"Unit Of Measure ID": "bananas"},
         "expect_rule": "pattern_mismatch", "expect_field": "Unit Of Measure ID",
         "model_basis": "Field declares a reference-data--UnitOfMeasure pattern.",
         "note": "CONTROL CASE. Already passes. Proves the constraint is "
                 "reachable when the key is canonical — contrast with M-CTRL."},
        {"id": "E3", "ac": "AC-3.2", "name": "inverted validity period",
         "patch": {"Valid From Datetime": "2027-01-01T00:00:00Z",
                   "Valid To Datetime": "2020-01-01T00:00:00Z"},
         "expect_rule": "temporal_consistency",
         "expect_field": ["Valid From Datetime", "Valid To Datetime"],
         "model_basis": "Fields form a validity pair via naming convention; "
                        "start must not follow end. No cross-field constraint "
                        "is expressible in the current model, so this must be "
                        "implemented in the validator."},
        {"id": "E4", "ac": "AC-3.3", "name": "malformed start datetime",
         "patch": {"Valid From Datetime": "not a date"},
         "expect_rule": "format_mismatch", "expect_field": "Valid From Datetime",
         "model_basis": "MODEL DEFECT (openfootprint#48): Valid From Datetime "
                        "declares constraints:null while its required partner "
                        "Valid To Datetime declares format:date-time. The "
                        "validator must not inherit this asymmetry."},
        {"id": "E5", "ac": "AC-3.3-control", "name": "malformed end datetime",
         "patch": {"Valid To Datetime": "not a date"},
         "expect_rule": "format_mismatch", "expect_field": "Valid To Datetime",
         "model_basis": "Field declares format:date-time.",
         "note": "CONTROL CASE. Already passes. Its pairing with E4 isolates "
                 "the model asymmetry as the sole cause of the E4 miss."},
        {"id": "E6", "ac": "AC-3.4", "name": "invalid enum member",
         "patch": {"Emission Recording Method Type ID":
                   "dveracity:reference-data--EmissionRecordingMethodType:scope9:1"},
         "expect_rule": "enum_membership",
         "expect_field": "Emission Recording Method Type ID",
         "model_basis": "Reference-data FK. Pattern passes, but the referent is "
                        "not a member of the reference set. Requires membership "
                        "checking beyond regex.",
         "note": "Distinguishes pattern conformance from referent validity."},
        {"id": "E7", "ac": "AC-4.1", "name": "deprecated field in use",
         "patch": {"Emission Report ID":
                   "dveracity:transactional-data--EmissionReport:R-1:1"},
         "expect_rule": "deprecated_field", "expect_field": "Emission Report ID",
         "expect_severity": "warning",
         "model_basis": "Field description begins 'DEPRECATED'. Four such "
                        "fields exist on this entity."},
        {"id": "N1", "ac": "AC-3.5", "name": "zero quantity is legitimate",
         "patch": {"Quantity": 0},
         "expect_rule": None,
         "model_basis": "NEGATIVE TEST. Zero emissions is a valid measurement. "
                        "Must not be swept up by the value_range check."},
        {"id": "N2", "ac": "AC-1.6", "name": "canonical payload is clean",
         "patch": {},
         "expect_rule": None,
         "model_basis": "NEGATIVE TEST. Baseline payload uses only canonical "
                        "field names and satisfies every declared constraint."},
    ],
}
# The sealed 01 carries a trailing newline (QA's edit); 02 and 03 do not.
# Reproduce each artifact byte-for-byte rather than normalising the seal.
(OUT / "01-semantic-error-probe.json").write_text(json.dumps(probe, indent=2) + "\n")

# ---------------------------------------------------------------- fixture 2
# Mis-mapped keys. All 50 target REAL canonical fields taken from the model.
# Tiers reflect how hard the resolution is, so didYouMean quality can be
# scored rather than just pass/fail.
def variants(canon):
    """Realistic ways a real integration mangles a canonical field name."""
    camel = re.sub(r"[^A-Za-z0-9]+", " ", canon).title().replace(" ", "")
    camel = camel[0].lower() + camel[1:]
    return {
        "lower_spaced": canon.lower(),
        "camel": camel,
        "snake": re.sub(r"[^A-Za-z0-9]+", "_", canon).lower(),
        "upper_snake": re.sub(r"[^A-Za-z0-9]+", "_", canon).upper(),
        "nospace": canon.replace(" ", ""),
    }

TARGETS = [
    ("Emission Statement", "Quantity"),
    ("Emission Statement", "Unit Of Measure ID"),
    ("Emission Statement", "Valid From Datetime"),
    ("Emission Statement", "Valid To Datetime"),
    ("Emission Statement", "Emission Activity ID"),
    ("Emission Statement", "Emission Component ID"),
    ("Emission Statement", "Name"),
    ("Emission Statement", "Description"),
    ("Emission Statement", "Emission Statement ID"),
    ("Emission Statement", "Emission Recording Method Type ID"),
]

# MEASURED 2026-09-07: the validator ALREADY normalises formatting variants.
# lowercase, snake_case, UPPER_SNAKE, NoSpace and camelCase all resolve to the
# canonical field and have its declared constraints applied. These are therefore
# REGRESSION CONTROLS (must keep passing), not gaps to close.
cases, seen_keys = [], set()
for ent, canon in TARGETS:
    for kind, mangled in variants(canon).items():
        if mangled == canon or mangled.lower() in seen_keys:
            continue
        seen_keys.add(mangled.lower())
        cases.append({
            "id": f"M{len(cases)+1:02d}", "entity": ent,
            "supplied_key": mangled, "expect_resolves_to": canon,
            "tier": "normalisation", "kind": kind,
            "expect_behaviour": "resolve_silently",
            "note": "Already passing as of 6c2d110. Regression control.",
        })

# Hand-authored hard cases: how real source systems actually name things.
HARD = [
    ("co2eKg", "Quantity", "hard", "common developer shorthand"),
    ("emissionQuantity", "Quantity", "hard", "descriptive synonym"),
    ("MENGE", "Quantity", "expert", "SAP field name for quantity"),
    ("MEINS", "Unit Of Measure ID", "expert", "SAP unit of measure"),
    ("uom", "Unit Of Measure ID", "hard", "ubiquitous abbreviation"),
    ("unit", "Unit Of Measure ID", "hard", "bare synonym"),
    ("periodStart", "Valid From Datetime", "hard", "reporting-period synonym"),
    ("periodEnd", "Valid To Datetime", "hard", "reporting-period synonym"),
    ("startDate", "Valid From Datetime", "hard", "generic temporal synonym"),
    ("validFrom", "Valid From Datetime", "moderate", "truncated canonical"),
    ("activityId", "Emission Activity ID", "moderate", "truncated canonical"),
    ("emission_activity", "Emission Activity ID", "hard", "FK suffix dropped"),
    ("statementName", "Name", "hard", "entity-prefixed"),
    ("desc", "Description", "hard", "common truncation"),
    ("Emision Statement ID", "Emission Statement ID", "moderate", "single-char typo"),
    ("Emission Statment ID", "Emission Statement ID", "moderate", "transposition typo"),
]
for key, canon, tier, why in HARD:
    if key.lower() in seen_keys:
        continue
    seen_keys.add(key.lower())
    cases.append({"id": f"M{len(cases)+1:02d}", "entity": "Emission Statement",
                  "supplied_key": key, "expect_resolves_to": canon,
                  "tier": tier, "kind": "realistic", "rationale": why,
                  "expect_behaviour": "warn_with_suggestion"})

# Controls that must NOT resolve to anything.
for key, why in [
    ("internal_row_hash", "pipeline metadata, no canonical counterpart"),
    ("__etl_batch_id", "loader artifact"),
    ("customerNotes", "genuinely foreign business field"),
    ("xyzzy", "nonsense control"),
]:
    cases.append({"id": f"M{len(cases)+1:02d}", "entity": "Emission Statement",
                  "supplied_key": key, "expect_resolves_to": None,
                  "tier": "control", "kind": "must_not_resolve", "rationale": why,
                  "expect_behaviour": "warn_without_suggestion"})

mismap = {
    "fixture": "mismapped-key-suite",
    "purpose": (
        "Separates what already works from what FR-1 must add. Measured at "
        "commit 6c2d110: formatting normalisation WORKS (5 variant styles), "
        "unknown_field warnings WORK for foreign keys, didYouMean suggestions "
        "are ABSENT (0 of 67). The remaining gap is semantic synonyms, not "
        "formatting."
    ),
    "tiers": {
        "normalisation": "Formatting variant. MUST resolve silently and have "
                         "the canonical field's constraints applied. Already "
                         "passing — regression control.",
        "moderate": "Truncation or typo. Should warn AND suggest.",
        "hard": "Semantic synonym. Should warn AND suggest. THE REAL GAP.",
        "expert": "Source-system name (SAP). Aspirational.",
        "control": "Genuinely foreign. MUST warn with NO suggestion.",
    },
    "scoring": {
        "normalisation": "pass = no warning AND constraints applied",
        "detection": "non-normalisation keys must produce an unknown_field entry",
        "resolution": "expect_resolves_to must appear in didYouMean",
        "control": "must produce unknown_field with EMPTY didYouMean",
        "targets": {"normalisation": 1.0, "moderate": 0.9,
                    "hard": 0.6, "expert": 0.3, "control": 1.0},
    },
    "base_payload": BASE,
    "cases": cases,
}
(OUT / "02-mismapped-key-suite.json").write_text(json.dumps(mismap, indent=2))

# ---------------------------------------------------------------- fixture 3
valid = {
    "fixture": "valid-payload-corpus",
    "purpose": (
        "Known-good payloads that must produce ZERO violations. Guards against "
        "false positives when new checks land. A check that breaks these is "
        "worse than the gap it closes."
    ),
    "cases": [
        {"id": "V1", "name": "minimal — requiredFields + primary key",
         "entity": "Emission Statement", "domain": "common-entities",
         "payload": {k: v for k, v in BASE.items()
                     if k in ES["requiredFields"] or k in ES["primaryKeys"]},
         "note": "MODEL CONTRACT GAP: building this from requiredFields alone "
                 "fails with primary_key_missing, because Emission Statement ID "
                 "is a primaryKey but is NOT listed in requiredFields "
                 "(required:false). Reported to openfootprint#48."},
        {"id": "V2", "name": "full — every non-deprecated field",
         "entity": "Emission Statement", "domain": "common-entities",
         "payload": BASE},
        {"id": "V3", "name": "zero quantity",
         "entity": "Emission Statement", "domain": "common-entities",
         "payload": {**BASE, "Quantity": 0}},
        {"id": "V4", "name": "single-instant validity period",
         "entity": "Emission Statement", "domain": "common-entities",
         "payload": {**BASE, "Valid From Datetime": "2026-09-01T00:00:00Z",
                     "Valid To Datetime": "2026-09-01T00:00:00Z"},
         "note": "start == end must be accepted; the rule is start <= end"},
        {"id": "V5", "name": "high-precision quantity",
         "entity": "Emission Statement", "domain": "common-entities",
         "payload": {**BASE, "Quantity": 0.000001234}},
        {"id": "V6", "name": "large quantity",
         "entity": "Emission Statement", "domain": "common-entities",
         "payload": {**BASE, "Quantity": 98765432.1}},
        {"id": "V7", "name": "unicode and punctuation in free text",
         "entity": "Emission Statement", "domain": "common-entities",
         "payload": {**BASE, "Name": "Café — Zone 3 (dîner), 50% capacity",
                     "Description": "Scope 2 · market-based · ≤2°C pathway"}},
        {"id": "V8", "name": "fractional-offset timezone",
         "entity": "Emission Statement", "domain": "common-entities",
         "payload": {**BASE, "Valid From Datetime": "2026-09-01T00:00:00+05:30",
                     "Valid To Datetime": "2026-09-30T23:59:59+05:30"},
         "note": "ISO 8601 permits non-hour offsets"},
    ],
}
(OUT / "03-valid-payload-corpus.json").write_text(json.dumps(valid, indent=2))

print(f"base payload fields: {len(BASE)}")
print(f"fixture 1 cases: {len(probe['cases'])}")
print(f"fixture 2 cases: {len(mismap['cases'])} "
      f"(controls: {sum(1 for c in cases if c['tier']=='control')})")
print(f"fixture 3 cases: {len(valid['cases'])}")
print("\nBASE:", json.dumps(BASE, indent=1))
