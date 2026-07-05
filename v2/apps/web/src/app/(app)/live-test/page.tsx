"use client";

import { useEffect, useMemo, useState } from "react";
import type { RouterTopology } from "@sr/shared";
import { useApi } from "@/hooks/use-api";

/** Common JSON-RPC probes per interface (kept small; the input is editable). */
const PRESETS: Record<string, { label: string; body: string }[]> = {
  jsonrpc: [
    { label: "eth_blockNumber", body: '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' },
    { label: "eth_chainId", body: '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' },
    { label: "eth_gasPrice", body: '{"jsonrpc":"2.0","method":"eth_gasPrice","params":[],"id":1}' },
    { label: "net_version", body: '{"jsonrpc":"2.0","method":"net_version","params":[],"id":1}' },
  ],
  tendermintrpc: [
    { label: "status", body: '{"jsonrpc":"2.0","method":"status","params":[],"id":1}' },
    { label: "health", body: '{"jsonrpc":"2.0","method":"health","params":[],"id":1}' },
  ],
};

interface TestResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  body: string;
  error?: string;
}

export default function LiveTestPage() {
  const config = useApi<{ routers: RouterTopology[] }>("/api/config/routers", 60000);
  // One selectable row per (chain, interface) that has a local listen port.
  const routers = useMemo(
    () =>
      (config.data?.routers ?? []).flatMap((r) =>
        (r.interfaces.length ? r.interfaces : [""]).flatMap((iface) => {
          const port = r.localPorts[iface] ?? r.localPort;
          return port ? [{ spec: r.spec, apiInterface: iface || "jsonrpc", listenPort: port }] : [];
        }),
      ),
    [config.data],
  );

  const [selected, setSelected] = useState<string>("");
  const [body, setBody] = useState(PRESETS.jsonrpc![0]!.body);
  const [skipCache, setSkipCache] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  useEffect(() => {
    if (!selected && routers[0]) {
      setSelected(`${routers[0].spec}|${routers[0].apiInterface}`);
    }
  }, [routers, selected]);

  const current = routers.find((r) => `${r.spec}|${r.apiInterface}` === selected);
  const presets = current ? (PRESETS[current.apiInterface] ?? PRESETS.jsonrpc!) : PRESETS.jsonrpc!;

  async function send() {
    if (!current?.listenPort) return;
    setRunning(true);
    setResult(null);
    const url = `http://localhost:${current.listenPort}`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (skipCache) headers["x-lava-skip-cache"] = "true";
    const t0 = performance.now();
    try {
      const res = await fetch(url, { method: "POST", headers, body });
      const text = await res.text();
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* leave raw */
      }
      setResult({ ok: res.ok, status: res.status, latencyMs: performance.now() - t0, body: pretty });
    } catch (err) {
      setResult({
        ok: false,
        status: 0,
        latencyMs: performance.now() - t0,
        body: "",
        error: err instanceof Error ? err.message : "Request failed",
      });
    } finally {
      setRunning(false);
    }
  }

  function curl(): string {
    if (!current?.listenPort) return "";
    const cacheHeader = skipCache ? ` -H 'x-lava-skip-cache: true'` : "";
    return `curl -X POST http://localhost:${current.listenPort} -H 'content-type: application/json'${cacheHeader} -d '${body}'`;
  }

  return (
    <div className="gw-page">
      <h1>Live test</h1>
      <p className="lede">Send a request straight through the router and inspect the response, status, and latency.</p>

      <div className="gw-grid" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
        {/* Request builder */}
        <div className="gw-card">
          <p className="gw-card__title">Request</p>

          <label className="gw-label">Router</label>
          <select className="gw-input" value={selected} onChange={(e) => setSelected(e.target.value)}>
            {routers.length === 0 && <option value="">No local routers found</option>}
            {routers.map((r) => (
              <option key={`${r.spec}|${r.apiInterface}`} value={`${r.spec}|${r.apiInterface}`}>
                {r.spec} · {r.apiInterface} (:{r.listenPort})
              </option>
            ))}
          </select>

          <div style={{ height: 14 }} />
          <label className="gw-label">Presets</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {presets.map((p) => (
              <button key={p.label} className="gw-btn" style={{ fontSize: 12, padding: "5px 10px" }} onClick={() => setBody(p.body)}>
                {p.label}
              </button>
            ))}
          </div>

          <div style={{ height: 14 }} />
          <label className="gw-label">Body</label>
          <textarea
            className="gw-input mono"
            style={{ minHeight: 120, resize: "vertical" }}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />

          <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, fontSize: 13 }}>
            <input type="checkbox" checked={skipCache} onChange={(e) => setSkipCache(e.target.checked)} />
            Skip cache
          </label>

          <button className="gw-btn gw-btn--primary" style={{ marginTop: 18, width: "100%", justifyContent: "center" }} onClick={send} disabled={running || !current}>
            {running ? "Sending…" : "Send request"}
          </button>

          <div style={{ height: 14 }} />
          <label className="gw-label">cURL</label>
          <pre className="mono" style={{ fontSize: 11, background: "var(--bg-2)", padding: 12, borderRadius: 10, overflowX: "auto", margin: 0 }}>{curl()}</pre>
        </div>

        {/* Response */}
        <div className="gw-card">
          <p className="gw-card__title">Response</p>
          {!result && <div className="muted" style={{ padding: 24, textAlign: "center" }}>Send a request to see the response.</div>}
          {result && (
            <>
              <div style={{ display: "flex", gap: 18, marginBottom: 14 }}>
                <div>
                  <div className="gw-card__title" style={{ margin: 0 }}>Status</div>
                  <span className={`tag ${result.ok ? "tag--ok" : "tag--err"}`}>{result.status || "ERR"}</span>
                </div>
                <div>
                  <div className="gw-card__title" style={{ margin: 0 }}>Latency</div>
                  <strong className="mono">{Math.round(result.latencyMs)} ms</strong>
                </div>
              </div>
              {result.error && <div className="tag tag--err" style={{ marginBottom: 12 }}>{result.error}</div>}
              {result.body && (
                <pre className="mono" style={{ fontSize: 12, background: "var(--bg-2)", padding: 14, borderRadius: 10, overflowX: "auto", maxHeight: 380, margin: 0 }}>{result.body}</pre>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
