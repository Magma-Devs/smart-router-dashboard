#!/usr/bin/env python3
"""Counting proxy — the node-side vantage point from the smart-router
`run-and-measure-locally` skill (section C).

Sits between the router and one upstream node. Every request is counted
BEFORE it is forwarded, so a request cannot be counted without reaching the
node, and the upstream status is recorded alongside it — without `by_outcome`
you cannot rule out that failed upstream calls tripped the ChainTracker's
failure backoff and changed the cadence you are measuring.

    GET  /__stats   counters + upstream RTT
    POST /__reset   zero the counters (settle 45s after boot, then reset, so
                    one-off startup verification traffic is excluded)

Anything else is proxied verbatim to UPSTREAM_URL.

Stdlib only, on purpose: the image is python:3.12-alpine with no pip step.
"""

import json
import os
import threading
import time
import urllib.error
import urllib.request
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = os.environ.get("UPSTREAM_URL", "https://ethereum-rpc.publicnode.com").rstrip("/")
PORT = int(os.environ.get("LISTEN_PORT", "8899"))
TIMEOUT = float(os.environ.get("UPSTREAM_TIMEOUT", "15"))

# The Lava gateway 403s Python's default User-Agent (urllib/x.y). Public
# vendors are less fussy, but sending a browser-ish UA costs nothing and this
# proxy is meant to be repointed at a gateway.
USER_AGENT = os.environ.get("PROXY_USER_AGENT", "curl/8.7.1")

_lock = threading.Lock()
_state = {
    "started_at": time.time(),
    "reset_at": time.time(),
    "total": 0,
    "by_method": Counter(),
    "by_outcome": Counter(),
    "rtt_ms": [],
}


def _reset() -> None:
    with _lock:
        _state["reset_at"] = time.time()
        _state["total"] = 0
        _state["by_method"].clear()
        _state["by_outcome"].clear()
        _state["rtt_ms"] = []


def _method_key(path: str, body: bytes) -> str:
    """Key a request the way the node sees it.

    JSON-RPC → the `method` field (a batch becomes one key per member, which
    is what the node's rate limiter counts too). Anything else (REST, GET) →
    `<VERB> <path>`.
    """
    if body:
        try:
            parsed = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            return f"raw {path}"
        if isinstance(parsed, list):
            return ",".join(str(m.get("method", "?")) for m in parsed if isinstance(m, dict)) or "batch"
        if isinstance(parsed, dict) and "method" in parsed:
            return str(parsed["method"])
    return f"path {path}"


def _percentile(values: list, pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, int(round((pct / 100.0) * (len(ordered) - 1))))
    return round(ordered[idx], 2)


def _snapshot() -> dict:
    with _lock:
        window = max(time.time() - _state["reset_at"], 1e-9)
        rtts = list(_state["rtt_ms"])
        return {
            "upstream": UPSTREAM,
            "window_seconds": round(window, 1),
            "total": _state["total"],
            "requests_per_min": round(_state["total"] / window * 60, 2),
            "by_method": dict(_state["by_method"].most_common()),
            "by_outcome": dict(_state["by_outcome"].most_common()),
            # Report upstream RTT with any measurement: the ChainTracker's poll
            # timer restarts AFTER the fetch, so a slow upstream throttles the
            # very poll rate you are trying to measure.
            "upstream_rtt_ms": {
                "count": len(rtts),
                "avg": round(sum(rtts) / len(rtts), 2) if rtts else 0.0,
                "p50": _percentile(rtts, 50),
                "p95": _percentile(rtts, 95),
                "max": round(max(rtts), 2) if rtts else 0.0,
            },
        }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "counting-proxy/1.0"

    def log_message(self, fmt, *args):  # noqa: A003 - silence per-request access logs
        pass

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, indent=2).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path.split("?")[0] == "/__stats":
            self._json(200, _snapshot())
            return
        self._proxy(b"")

    def do_POST(self):  # noqa: N802
        path = self.path.split("?")[0]
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else b""
        if path == "/__reset":
            _reset()
            self._json(200, {"reset": True, "at": time.time()})
            return
        if path == "/__stats":
            self._json(200, _snapshot())
            return
        self._proxy(body)

    def _proxy(self, body: bytes) -> None:
        # Count BEFORE forwarding: a request must never reach the node
        # uncounted, even if the forward then fails.
        key = _method_key(self.path, body)
        with _lock:
            _state["total"] += 1
            _state["by_method"][key] += 1

        req = urllib.request.Request(
            UPSTREAM + self.path,
            data=body if body else None,
            method=self.command,
        )
        req.add_header("content-type", self.headers.get("content-type", "application/json"))
        req.add_header("accept", self.headers.get("accept", "application/json"))
        req.add_header("user-agent", USER_AGENT)

        started = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                status, payload = resp.status, resp.read()
                ctype = resp.headers.get("content-type", "application/json")
        except urllib.error.HTTPError as exc:
            status, payload = exc.code, exc.read()
            ctype = exc.headers.get("content-type", "application/json") if exc.headers else "application/json"
        except Exception as exc:  # noqa: BLE001 - any transport failure is an outcome
            status, payload, ctype = 599, json.dumps({"error": str(exc)}).encode(), "application/json"

        elapsed_ms = (time.perf_counter() - started) * 1000
        with _lock:
            _state["by_outcome"][str(status)] += 1
            _state["rtt_ms"].append(elapsed_ms)

        try:
            self.send_response(status)
            self.send_header("content-type", ctype)
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            # The router hung up (relay race cancel / timeout). Already counted.
            pass


if __name__ == "__main__":
    print(f"counting-proxy: :{PORT} -> {UPSTREAM}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
