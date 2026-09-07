"""Minimal MCP client for the dVeracity semantic endpoint.

Shells out to curl deliberately: dependency-light, and it avoids the Python-TLS
workarounds documented for the QA sandbox.

Auth, in order of precedence:

1. ``DVERACITY_API_KEY`` in the environment — use this in CI, from a repository
   secret. The key is written to a private temp file and passed via ``curl -H
   @file`` so it never appears in the process list or in CI logs.
2. Otherwise, no auth header is sent, and the request is expected to be
   authenticated by an outbound credential proxy (how the QA sandbox runs).
"""
import json
import os
import stat
import subprocess
import tempfile
import time

ENDPOINT = os.environ.get("DVERACITY_ENDPOINT", "https://api.dveracity.com/mcp")
_API_KEY = os.environ.get("DVERACITY_API_KEY")
_HEADER_FILE = None


def _header_file():
    """Private temp file holding the auth header, created once per process."""
    global _HEADER_FILE
    if _HEADER_FILE is None and _API_KEY:
        fd, path = tempfile.mkstemp(prefix="dve-hdr-")
        os.fchmod(fd, stat.S_IRUSR | stat.S_IWUSR)
        with os.fdopen(fd, "w") as fh:
            fh.write(f"X-Api-Key: {_API_KEY}\n")
        _HEADER_FILE = path
    return _HEADER_FILE


def call(tool, args, timeout=60):
    """Call an MCP tool. Returns (parsed_result, elapsed_seconds).

    The sentinel tool name ``__initialize__`` issues an MCP ``initialize``
    handshake instead and returns the raw result, so a caller can record which
    server build produced its numbers. Costs no credits.
    """
    if tool == "__initialize__":
        body = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                           "clientInfo": {"name": "dve-conformance",
                                          "version": "1"}}}
    else:
        body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": tool, "arguments": args}}
    payload = json.dumps(body)
    cmd = [
        "curl", "-s", "-X", "POST", ENDPOINT,
        "-H", "Content-Type: application/json",
        "-H", "Accept: application/json, text/event-stream",
        "--max-time", str(timeout),
        "-d", payload,
    ]
    hdr = _header_file()
    if hdr:
        cmd += ["-H", f"@{hdr}"]
    t0 = time.perf_counter()
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    elapsed = time.perf_counter() - t0

    line = None
    for raw in out.splitlines():
        s = raw[6:] if raw.startswith("data: ") else raw
        if s.startswith("{"):
            line = s
    if line is None:
        return {"_transport_error": out[:400]}, elapsed

    msg = json.loads(line)
    if "error" in msg:
        return {"_rpc_error": msg["error"]}, elapsed
    res = msg.get("result", {})
    if tool == "__initialize__":
        return res, elapsed
    text = "".join(c.get("text", "") for c in res.get("content", []))
    if res.get("isError"):
        return {"_tool_error": text}, elapsed
    try:
        return json.loads(text), elapsed
    except json.JSONDecodeError:
        return {"_raw": text}, elapsed


def validate(entity, payload, domain=None, sector=None, entity_type=None):
    args = {"entity": entity, "payload": payload}
    if domain:
        args["domain"] = domain
    if sector:
        args["sector"] = sector
    if entity_type:
        args["entityType"] = entity_type
    return call("ofp_validate", args)
