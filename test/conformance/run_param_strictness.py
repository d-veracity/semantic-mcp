#!/usr/bin/env python3
"""Parameter-strictness conformance suite — d-veracity/semantic-mcp#11.

ACCEPTED-RED. Every case fails at server 0.5.2. This suite encodes the agreed
target behaviour from #11, not observed behaviour, so it must not gate CI until
#11 ships. Run with --gate once it does.

Expectations derive from each tool's own published inputSchema. Where a tool
declares additionalProperties:false, rejecting unknown keys is the contract the
server already advertises; this asserts nothing new.

Covers the paid tools on every run by explicit decision (2026-09-07). Pass
--no-paid to skip them. Cost is reported at the end of each run.

The cost should be self-cancelling once #11 ships: a rejected call ought not to
reach billing. If credits are still charged after rejection lands, that is a
separate defect worth filing.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "fixtures", "04-parameter-strictness.json")
ENDPOINT = os.environ.get("DVERACITY_ENDPOINT", "https://api.dveracity.com/mcp")

GATE = "--gate" in sys.argv
INCLUDE_PAID = "--no-paid" not in sys.argv


def _post(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    cmd = ["curl", "-s", "-X", "POST", ENDPOINT,
           "-H", "Content-Type: application/json",
           "-H", "Accept: application/json, text/event-stream"]
    key = os.environ.get("DVERACITY_API_KEY")
    if key:
        cmd += ["-H", f"X-Api-Key: {key}"]
    cmd += ["-d", body]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=60).stdout
    lines = [l[6:] if l.startswith("data: ") else l
             for l in out.splitlines() if l.strip().startswith(("data: {", "{"))]
    return json.loads(lines[-1]) if lines else {}


def call(tool, args):
    """Returns (is_error, parsed_or_text)."""
    res = _post("tools/call", {"name": tool, "arguments": args}).get("result", {})
    text = "".join(c.get("text", "") for c in res.get("content", []))
    try:
        return bool(res.get("isError")), json.loads(text)
    except Exception:
        return bool(res.get("isError")), text


def credits_balance():
    """credits_balance is itself free, so bracketing a run with it is honest."""
    try:
        _, b = call("credits_balance", {})
        return b["data"]["balance"]
    except Exception:
        return None


def entity_names(parsed):
    try:
        return [e["name"] for e in parsed["data"]["entities"]]
    except Exception:
        return None


fx = json.load(open(FIXTURE))
cases = {c["id"]: c for c in fx["cases"]}
results = {}
server = _post("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                              "clientInfo": {"name": "dve-conformance", "version": "1"}})
info = server.get("result", {}).get("serverInfo")
print(f"server under test: {info}")
print(f"suite status     : {fx['status']}  ({fx['issue']})")
start_balance = credits_balance()
print(f"credits before   : {start_balance}")
print(f"paid tools       : {'included' if INCLUDE_PAID else 'skipped (--no-paid)'}\n")


def run_rejection(case):
    """Unknown key supplied alongside valid required args must be rejected."""
    rows = []
    for t in case["tools"]:
        if t.get("costs_credits") and not INCLUDE_PAID:
            rows.append({"tool": t["tool"], "skipped": "paid", "pass": None})
            continue
        args = dict(t["valid"])
        args[case["junk_key"]] = "xyzzy"
        is_err, body = call(t["tool"], args)
        names_key = case["junk_key"] in json.dumps(body) if is_err else False
        rows.append({"tool": t["tool"], "rejected": is_err, "names_key": names_key,
                     "pass": is_err and names_key})
    return rows


for cid in ("P1", "P2"):
    c = cases[cid]
    rows = run_rejection(c)
    ran = [r for r in rows if r["pass"] is not None]
    npass = sum(r["pass"] for r in ran)
    results[cid] = {"passed": npass, "total": len(ran), "rows": rows,
                    "pass": bool(ran) and npass == len(ran)}
    print(f"{cid} {c['name']}")
    print(f"   {npass}/{len(ran)} reject an unknown argument")
    for r in rows:
        if r["pass"] is None:
            print(f"     skip  {r['tool']:<22} paid tool, --no-paid")
        elif not r["pass"]:
            print(f"     MISS  {r['tool']:<22} accepted the unknown key")
    print()

# P3 — near miss must not silently change the answer
c = cases["P3"]
_, correct = call(c["tool"], c["correct"])
nm_err, near = call(c["tool"], c["near_miss"])
_, ctrl = call(c["tool"], c["control"])
n_correct, n_near, n_ctrl = entity_names(correct), entity_names(near), entity_names(ctrl)
silently_dropped = (n_near == n_ctrl)
results["P3"] = {"rejected": nm_err, "silently_dropped": silently_dropped,
                 "correct_n": len(n_correct or []), "near_n": len(n_near or []),
                 "pass": nm_err or not silently_dropped}
print(f"P3 {c['name']}")
print(f"   correct   q=sequestration     -> {len(n_correct or [])} entities")
print(f"   near miss query=sequestration -> {len(n_near or [])} entities")
print(f"   control   no argument         -> {len(n_ctrl or [])} entities")
print(f"   argument silently discarded   : {silently_dropped}")
print(f"   PASS: {results['P3']['pass']}\n")

# P4 — misattribution. Costs a credit.
c = cases["P4"]
if INCLUDE_PAID:
    corpus = json.load(open(os.path.join(HERE, "fixtures", "03-valid-payload-corpus.json")))
    v = corpus["cases"][0]
    base = {"entity": v["entity"], "domain": v.get("domain"), "payload": v["payload"]}
    _, nm = call(c["tool"], {**base, c["near_miss_arg"]: c["value"]})
    # #11's fix makes the SDK reject unknown keys before a handler runs, so a
    # rejected call surfaces as an isError:true result whose content is text,
    # not a dict shaped like a successful ofp_validate response. call() then
    # returns that text as a plain str, and this line must not assume dict
    # (was: AttributeError: 'str' object has no attribute 'get', reported on
    # #11 against the fix/11-parameter-strictness branch). No policy object at
    # all is itself evidence the misattribution cannot occur, so treat it as {}.
    pol = (nm.get("data") or {}).get("policy") or {} if isinstance(nm, dict) else {}
    misattributed = pol.get("reason") == "no_sector_supplied"
    results["P4"] = {"reason": pol.get("reason"), "misattributed": misattributed,
                     "pass": not misattributed}
    print(f"P4 {c['name']}")
    print(f"   passed '{c['near_miss_arg']}' -> policy.reason = {pol.get('reason')!r}")
    print(f"   misattributes cause          : {misattributed}")
    print(f"   PASS: {not misattributed}\n")
else:
    results["P4"] = {"skipped": "paid tool, --no-paid", "pass": None}
    print("P4 skipped (paid tool, --no-paid)\n")

end_balance = credits_balance()
spent = (start_balance - end_balance) if None not in (start_balance, end_balance) else None
print(f"credits: {start_balance} -> {end_balance}   spent this run: {spent}")
if spent:
    print("Expected to fall to 0 once #11 ships, since a rejected call should not")
    print("reach billing. If it does not, that is a separate defect.")

out = {"server": info, "suite": fx["suite"], "issue": fx["issue"],
       "status": fx["status"], "paid_tools_included": INCLUDE_PAID,
       "credits": {"before": start_balance, "after": end_balance, "spent": spent},
       "results": results}
path = os.path.join(HERE, "baseline-param-strictness.json")
json.dump(out, open(path, "w"), indent=2)
print(f"wrote {path}")

failing = [k for k, v in results.items() if v.get("pass") is False]
if not GATE:
    print(f"\nACCEPTED-RED — not gating. Failing: {failing or 'none'}")
    print(f"Flip to --gate once {fx['issue']} ships.")
    sys.exit(0)
if failing:
    print(f"\nFAIL: {failing}")
    sys.exit(1)
print("\nAll parameter-strictness cases pass.")
