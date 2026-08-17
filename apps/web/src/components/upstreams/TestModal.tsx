"use client";

/* Test connection modal — design chrome from page-providers.jsx TestModal,
 * but the test is REAL: it POSTs through the router's local listen port
 * (same pattern as the Live test page), never a staged setTimeout result.
 * When no local port exists in the mounted config, the run button is
 * disabled-honest. */

import { useEffect, useMemo, useState } from "react";
import type { RouterTopology } from "@sr/shared";
import { Modal } from "@/components/gateway/Modal";
import { HealthDot } from "@/components/gateway/HealthTag";
import type { UpstreamRow } from "@/components/upstreams/catalog";

const NO_PORT_MSG = "No routable address for this upstream's chains in the mounted config";

/** POST-able probe per api-interface (mirrors the Live test presets). */
const TEST_PRESETS: Record<string, { method: string; body: string }> = {
  jsonrpc: { method: "eth_blockNumber", body: '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' },
  tendermintrpc: { method: "status", body: '{"jsonrpc":"2.0","method":"status","params":[],"id":1}' },
};

interface TestTarget { url: string; iface: string; method: string; body: string }
interface TestOutcome { ms: number; detail: string }

export function TestModal({ open, onClose, upstream, routers }: {
  open: boolean;
  onClose: () => void;
  upstream: UpstreamRow | null;
  routers: RouterTopology[];
}) {
  const [stage, setStage] = useState<"idle" | "running" | "ok" | "err">("idle");
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const [errMsg, setErrMsg] = useState("");

  useEffect(() => { if (!open) { setStage("idle"); setOutcome(null); setErrMsg(""); } }, [open]);

  /* First (router, interface) of this upstream with a POST-able address —
     the published gateway URL (helm values) or a local listen port
     (SR_CONFIG). */
  const target = useMemo<TestTarget | null>(() => {
    for (const row of upstream?.chainRows ?? []) {
      const router = routers.find((r) => r.id === row.routerId);
      if (!router) continue;
      for (const iface of [row.iface, ...router.interfaces]) {
        const preset = TEST_PRESETS[iface];
        if (!preset) continue;
        const port = router.localPorts[iface] ?? router.localPort;
        const url = router.publicUrls[iface] ?? (port ? `http://localhost:${port}` : null);
        if (url) return { url, iface, method: preset.method, body: preset.body };
      }
    }
    return null;
  }, [upstream, routers]);

  const run = async () => {
    if (!target || !upstream) return;
    setStage("running");
    setOutcome(null);
    setErrMsg("");
    const t0 = performance.now();
    try {
      const res = await fetch(target.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Pin the relay to the upstream this modal is about. Without it the
          // router picks whichever upstream it likes and a green "Connection
          // successful" says nothing about the one under test. The name is the
          // node name the api reflects — already folded to what the router
          // registers, so it matches `provider_address` exactly.
          "lava-select-provider": upstream.name,
        },
        body: target.body,
      });
      const ms = Math.round(performance.now() - t0);
      const text = await res.text();
      let detail = text.slice(0, 60);
      let rpcError: string | null = null;
      try {
        const json = JSON.parse(text) as { result?: unknown; error?: { message?: string } };
        if (json.error) rpcError = json.error.message || "RPC error";
        else detail = typeof json.result === "string" ? json.result : JSON.stringify(json.result ?? null).slice(0, 60);
      } catch { /* keep raw slice */ }
      if (!res.ok) { setErrMsg(`HTTP ${res.status}${rpcError ? ` · ${rpcError}` : ""}`); setStage("err"); return; }
      if (rpcError) { setErrMsg(`${rpcError} · ${ms}ms`); setStage("err"); return; }
      setOutcome({ ms, detail });
      setStage("ok");
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : "Request failed");
      setStage("err");
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Test connection"
      footer={<>
        <button className="gw-btn" onClick={onClose}>Close</button>
        {stage === "idle" && (
          <button className="gw-btn gw-btn--primary" onClick={run} disabled={!target}
            title={target ? undefined : NO_PORT_MSG}>Run test</button>
        )}
      </>}>
      {upstream && (
        <div style={{ display: "grid", gap: 14 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <HealthDot health={upstream.health} size={8} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{upstream.name}</div>
              <div className="gw-secret">{target ? target.url : upstream.url || "—"}</div>
            </div>
          </div>
          {!target && (
            <div style={{ padding: "12px 14px", borderRadius: 8, background: "var(--hover)", fontSize: 12, color: "var(--text-3)", lineHeight: 1.5 }}>
              {NO_PORT_MSG}.
            </div>
          )}
          {target && (
            <div style={{ fontSize: 12, color: "var(--text-3)", lineHeight: 1.5 }}>
              Sent through the router, pinned to this upstream with the{" "}
              <span className="gw-mono">lava-select-provider</span> header — the router&apos;s
              cache can still answer it.
            </div>
          )}
          {stage === "running" && target && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderRadius: 8, background: "var(--hover)", fontSize: 13 }}>
              <svg width="14" height="14" viewBox="0 0 14 14" style={{ animation: "spin2 0.8s linear infinite" }}><style>{"@keyframes spin2{to{transform:rotate(360deg)}}"}</style><circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--brand)" strokeWidth="1.8" strokeDasharray="20 10"/></svg>
              Running {target.method}…
            </div>
          )}
          {stage === "ok" && outcome && target && (
            <div style={{ padding: "12px 14px", borderRadius: 8, background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.2)" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ok)" }}>Connection successful</span>
              </div>
              <div className="gw-mono" style={{ fontSize: 11, color: "var(--text-2)" }}>{target.method} → {outcome.detail} · {outcome.ms}ms</div>
            </div>
          )}
          {stage === "err" && (
            <div style={{ padding: "12px 14px", borderRadius: 8, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--err)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--err)" }}>Request failed</span>
              </div>
              <div className="gw-mono" style={{ fontSize: 11, color: "var(--text-2)" }}>{errMsg}</div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
