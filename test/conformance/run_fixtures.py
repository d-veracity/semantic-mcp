"""Run the sealed fixtures against a dVeracity endpoint and emit a baseline report.

Usage:  python3 run_fixtures.py [--latency N]

Credit note: ofp_validate costs 1 credit per call. Fixture 2 is deliberately
BATCHED — the validator returns every unknown-field warning in a single
response, so 67 mis-mapped keys cost ~3 credits rather than 67. Keep it that
way when this runs in CI.
"""
import json
import pathlib
import statistics
import sys

import mcp

F = pathlib.Path(__file__).parent / "fixtures"
LAT_N = 30
if "--latency" in sys.argv:
    LAT_N = int(sys.argv[sys.argv.index("--latency") + 1])

report = {"endpoint": mcp.ENDPOINT, "results": {}}

# Record WHICH SERVER BUILD produced these numbers. Without it a baseline cannot
# be compared across runs: a version string read on one day and a repo cloned on
# another will silently disagree, and you will not know which build the numbers
# describe. Free — initialize costs no credits.
_init, _ = mcp.call("__initialize__", None)
report["server"] = _init.get("serverInfo") if isinstance(_init, dict) else None
if not report["server"]:
    print("WARNING: could not read serverInfo; baseline is unattributed.")


def parts(r):
    d = r.get("data", {})
    s = d.get("schema", {})
    return d, s.get("violations", []), s.get("warnings", [])


# ---------------------------------------------------------------- fixture 1
probe = json.loads((F / "01-semantic-error-probe.json").read_text())
rows, lat = [], []
for c in probe["cases"]:
    p = dict(probe["base_payload"]); p.update(c["patch"])
    r, el = mcp.validate(probe["entity"], p, domain=probe["domain"])
    lat.append(el)
    d, v, w = parts(r)
    found = [x.get("rule") for x in v] + [x.get("rule") for x in w]
    want = c["expect_rule"]
    ok = (want is None and not v and not w) or (want is not None and want in found)
    rows.append({"id": c["id"], "ac": c["ac"], "name": c["name"],
                 "expect": want, "found": found, "pass": ok,
                 "control": "CONTROL" in (c.get("note") or ""),
                 "negative": want is None})
    if "commit" not in report:
        report["commit"] = r.get("source", {}).get("commit")

real = [r for r in rows if not r["negative"]]
report["results"]["semantic_error_probe"] = {
    "cases": len(rows),
    "detected": sum(1 for r in real if r["pass"]),
    "detectable": len(real),
    "negative_tests_pass": sum(1 for r in rows if r["negative"] and r["pass"]),
    "negative_tests": sum(1 for r in rows if r["negative"]),
    "detail": rows,
}

# ---------------------------------------------------------------- fixture 2
mis = json.loads((F / "02-mismapped-key-suite.json").read_text())
cases = mis["cases"]
seen, chunks = {}, [cases[i:i + 25] for i in range(0, len(cases), 25)]
for ch in chunks:
    p = dict(mis["base_payload"])
    for c in ch:
        p[c["supplied_key"]] = "PROBE"
    r, el = mcp.validate("Emission Statement", p, domain="common-entities")
    lat.append(el)
    _, v, w = parts(r)
    for entry in list(v) + list(w):
        if entry.get("rule") == "unknown_field":
            seen[entry.get("field")] = entry

mrows = []
for c in cases:
    e = seen.get(c["supplied_key"])
    sug = [s.get("field") if isinstance(s, dict) else s
           for s in (e or {}).get("didYouMean", []) or []]
    want = c["expect_resolves_to"]
    detected = e is not None
    beh = c.get("expect_behaviour")
    if beh == "resolve_silently":
        # Correct behaviour is to absorb the variant with NO warning.
        ok = not detected
        resolved = not detected
    elif beh == "warn_without_suggestion":
        ok = detected and not sug
        resolved = detected and not sug
    else:  # warn_with_suggestion
        ok = detected and (want in sug)
        resolved = want in sug
    mrows.append({
        "id": c["id"], "key": c["supplied_key"], "tier": c["tier"],
        "expect_behaviour": beh, "expect": want, "detected": detected,
        "suggestions": sug, "resolved": resolved, "pass": ok,
    })

by_tier = {}
for m in mrows:
    t = by_tier.setdefault(m["tier"], {"n": 0, "pass": 0, "detected": 0,
                                       "resolved": 0})
    t["n"] += 1
    t["pass"] += m["pass"]
    t["detected"] += m["detected"]
    t["resolved"] += m["resolved"]

report["results"]["mismapped_keys"] = {
    "cases": len(mrows),
    "pass": sum(1 for m in mrows if m["pass"]),
    "detected": sum(1 for m in mrows if m["detected"]),
    "resolved": sum(1 for m in mrows if m["resolved"]),
    "by_tier": by_tier,
    "credits_used": len(chunks),
    "detail": mrows,
}

# ---------------------------------------------------------------- fixture 3
val = json.loads((F / "03-valid-payload-corpus.json").read_text())
vrows = []
for c in val["cases"]:
    r, el = mcp.validate(c["entity"], c["payload"], domain=c["domain"])
    lat.append(el)
    d, v, w = parts(r)
    vrows.append({"id": c["id"], "name": c["name"], "valid": d.get("valid"),
                  "violations": [x.get("rule") for x in v],
                  "warnings": [x.get("rule") for x in w],
                  "pass": not v})
report["results"]["valid_corpus"] = {
    "cases": len(vrows),
    "clean": sum(1 for r in vrows if r["pass"]),
    "false_positives": sum(1 for r in vrows if not r["pass"]),
    "detail": vrows,
}

# ---------------------------------------------------------------- latency
# --latency 0 skips this suite entirely. Use it on PR runs: it is the single
# most expensive part of the suite (1 credit per sample).
if LAT_N > 0:
    base = json.loads((F / "03-valid-payload-corpus.json").read_text())["cases"][1]
    lats = []
    for _ in range(LAT_N):
        _, el = mcp.validate(base["entity"], base["payload"], domain=base["domain"])
        lats.append(el * 1000)
    lats.sort()
    report["results"]["latency_ms"] = {
        "n": len(lats),
        "p50": round(statistics.median(lats), 1),
        "p90": round(lats[int(len(lats) * 0.9) - 1], 1),
        "min": round(lats[0], 1),
        "max": round(lats[-1], 1),
        "note": "Wall clock incl. network from the client, not server-side time. "
                "Treat as a regression signal, not an SLA.",
    }
else:
    report["results"]["latency_ms"] = {"n": 0, "skipped": True}

out = pathlib.Path(__file__).parent / "baseline.json"
out.write_text(json.dumps(report, indent=2))

s = report["results"]
print(f"server under test: {report.get('server')}")
print(f"model commit     : {report.get('commit')}")
print(f"error probe   : {s['semantic_error_probe']['detected']}"
      f"/{s['semantic_error_probe']['detectable']} detected  |  "
      f"{s['semantic_error_probe']['negative_tests_pass']}"
      f"/{s['semantic_error_probe']['negative_tests']} negative tests pass")
mk = s["mismapped_keys"]
print(f"mismapped keys: {mk['pass']}/{mk['cases']} pass   "
      f"({mk['credits_used']} credits, batched)")
for t, x in mk["by_tier"].items():
    print(f"    {t:16} {x['pass']}/{x['n']} pass")
print(f"valid corpus  : {s['valid_corpus']['clean']}"
      f"/{s['valid_corpus']['cases']} clean  |  "
      f"{s['valid_corpus']['false_positives']} false positives")
lm = s["latency_ms"]
if lm["n"]:
    print(f"latency       : p50 {lm['p50']}ms  p90 {lm['p90']}ms  (n={lm['n']})")
else:
    print("latency       : skipped")
print(f"\nwrote {out}")

# Regression gate. Tiers that pass today MUST keep passing; everything else is
# reported but not enforced, so the gaps do not block unrelated work.
fails = []
if s["valid_corpus"]["false_positives"]:
    fails.append(f"{s['valid_corpus']['false_positives']} false positive(s) "
                 f"on the valid-payload corpus")
for tier, target in (("normalisation", 24), ("control", 4)):
    got = mk["by_tier"].get(tier, {}).get("pass", 0)
    if got < target:
        fails.append(f"{tier} tier regressed: {got}/{target}")
if s["semantic_error_probe"]["negative_tests_pass"] < \
        s["semantic_error_probe"]["negative_tests"]:
    fails.append("a negative test fired on a legitimate payload")

if fails:
    print("\nREGRESSION:")
    for f in fails:
        print(f"  - {f}")
    sys.exit(1)
print("\nNo regression against the sealed baseline.")
