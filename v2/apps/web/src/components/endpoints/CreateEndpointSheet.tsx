"use client";

/* Create endpoint sheet — the design's multi-step wizard (page-endpoints.jsx
 * CreateEndpointSheet: Chain → Interface → Upstreams → JWT). SELF-HOSTED:
 * the full wizard chrome renders over LIVE config data (chains = the mounted
 * routers, upstreams = the config nodes), but "Create endpoint" is disabled —
 * the config is a read-only mount. The JWT reveal step is never reached and
 * no token is ever fabricated (the design's genJwt is deliberately not
 * ported). */

import { useEffect, useMemo, useState } from "react";
import type { RouterTopology } from "@sr/shared";
import { buildChainMetaByIndex } from "@sr/shared";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { Hint } from "@/components/upstreams/bits";
import { READONLY_MSG, type UpstreamRow } from "@/components/upstreams/catalog";
import {
  EpStepBar,
  IFACES_DEF,
  configIfaceForTag,
  type EndpointRowModel,
} from "@/components/endpoints/bits";

export function CreateEndpointSheet({ open, onClose, routers, upstreams, existing }: {
  open: boolean;
  onClose: () => void;
  routers: RouterTopology[];
  upstreams: UpstreamRow[];
  existing: EndpointRowModel[];
}) {
  const [step, setStep] = useState(1);
  const [chain, setChain] = useState<string | null>(null);
  const [iface, setIface] = useState("jsonrpc");
  const [selUpstreams, setSelUpstreams] = useState<string[] | null>(null); // null = not yet initialised

  /* Chains covered by the mounted config. */
  const availableChains = useMemo(() => {
    const seen = new Set<string>();
    const out: { spec: string; name: string }[] = [];
    for (const r of routers) {
      if (seen.has(r.spec)) continue;
      seen.add(r.spec);
      out.push({ spec: r.spec, name: buildChainMetaByIndex(r.spec).name });
    }
    return out;
  }, [routers]);

  const cfgIface = configIfaceForTag(iface);

  /* All upstreams compatible with the selected interface.
     No chain filter — user picks from everything they have connected. */
  const chainUpstreams = useMemo(() => {
    return upstreams.filter((p) => !p.interfaces.length || p.interfaces.includes(cfgIface));
  }, [upstreams, cfgIface]);

  useEffect(() => {
    if (open) {
      setStep(1);
      setChain(null);
      setIface("jsonrpc");
      setSelUpstreams(null);
    }
  }, [open]);

  /* When chain or chainUpstreams change, reset selections */
  useEffect(() => {
    setSelUpstreams(chainUpstreams.map((p) => p.id));
  }, [chainUpstreams]);

  const toggleUpstream = (id: string) =>
    setSelUpstreams((prev) => (prev ?? []).includes(id) ? (prev ?? []).filter((x) => x !== id) : [...(prev ?? []), id]);

  const stepLabels = ["Chain", "Interface", "Upstreams", "JWT"];
  const conflict = !!chain && existing.some((e) => e.spec === chain && e.iface === cfgIface);
  const hostPreview = (() => {
    if (!chain) return "—";
    const r = routers.find((rt) => rt.spec === chain && (rt.localPorts[cfgIface] ?? rt.localPort) !== null);
    const port = r ? (r.localPorts[cfgIface] ?? r.localPort) : null;
    return port !== null && port !== undefined ? `localhost:${port}` : "—";
  })();

  if (!open) return null;

  return (
    <div className="gw-sheet-bg" onClick={onClose}>
      <div className="gw-sheet gw-sheet--wide" onClick={(e) => e.stopPropagation()}>

        {/* Head */}
        <div className="gw-sheet__head">
          <div>
            <p className="gw-sheet__title">New endpoint</p>
            <p className="gw-sheet__sub">
              Stable local URL served by your configured upstreams.
            </p>
          </div>
          <button className="gw-btn gw-btn--ghost" style={{ padding: 5 }} onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <EpStepBar steps={stepLabels} current={step} />

        {/* Body */}
        <div className="gw-sheet__body">

          {/* Step 1 — Chain */}
          {step === 1 && (
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ fontSize: 12, color: "var(--text-3)" }}>Select the chain for this endpoint.</div>
              {availableChains.length === 0 && (
                <div style={{ padding: "16px", borderRadius: 9, background: "var(--bg)", border: "1px solid var(--line)", textAlign: "center" }}>
                  <div style={{ fontSize: 13, color: "var(--text-3)", marginBottom: 6 }}>No chains in the mounted config.</div>
                  <div style={{ fontSize: 11, color: "var(--text-4)" }}>Mount your router values file to pick from its chains.</div>
                </div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, maxHeight: 340, overflowY: "auto" }}>
                {availableChains.map((c) => {
                  const isSelected = chain === c.spec;
                  const hasEp = existing.some((e) => e.spec === c.spec && e.iface === cfgIface);
                  return (
                    <button key={c.spec} onClick={() => setChain(c.spec)} style={{
                      position: "relative", display: "flex", flexDirection: "column", alignItems: "center",
                      gap: 7, padding: "13px 10px", borderRadius: 10, cursor: "pointer",
                      border: "1px solid " + (isSelected ? "var(--brand)" : "var(--line)"),
                      background: isSelected ? "rgba(255,57,0,0.07)" : "var(--bg)", fontFamily: "inherit",
                      transition: "border-color 0.1s, background 0.1s",
                    }}>
                      <ChainBadge spec={c.spec} size={24} />
                      <span style={{ fontSize: 11, fontWeight: 600, color: isSelected ? "var(--brand)" : "var(--text-2)" }}>{c.name}</span>
                      {hasEp && <span title="Endpoint exists" style={{ position: "absolute", top: 5, right: 5, width: 6, height: 6, borderRadius: "50%", background: "var(--ok)" }} />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Step 2 — Interface */}
          {step === 2 && (
            <div style={{ display: "grid", gap: 9 }}>
              <div style={{ fontSize: 12, color: "var(--text-3)" }}>
                URL: <span className="gw-mono" style={{ fontSize: 11, color: "var(--text-2)" }}>{hostPreview}</span>
              </div>
              {IFACES_DEF.map((i) => (
                <button key={i.id} disabled={!!i.comingSoon} onClick={() => setIface(i.id)} style={{
                  display: "flex", alignItems: "center", gap: 14, padding: "13px 15px", borderRadius: 10,
                  cursor: i.comingSoon ? "not-allowed" : "pointer", opacity: i.comingSoon ? 0.45 : 1,
                  border: "1px solid " + (iface === i.id && !i.comingSoon ? i.color + "66" : "var(--line)"),
                  background: iface === i.id && !i.comingSoon ? i.color + "0d" : "var(--bg)",
                  fontFamily: "inherit", textAlign: "left", width: "100%",
                }}>
                  <div style={{ width: 36, height: 36, borderRadius: 9, background: i.color + "20", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <span style={{ fontSize: 9, fontWeight: 800, color: i.color, letterSpacing: "0.04em" }}>{i.label.slice(0, 4)}</span>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{i.label}</span>
                      {i.comingSoon && <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", padding: "2px 5px", borderRadius: 3, background: "var(--hover)", color: "var(--text-3)" }}>Soon</span>}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 2 }}>{i.desc}</div>
                  </div>
                  {iface === i.id && !i.comingSoon && (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="20 6 9 17 4 12"/></svg>
                  )}
                </button>
              ))}
              {conflict && (
                <div style={{ padding: "8px 12px", borderRadius: 7, background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.2)", fontSize: 12, color: "var(--warn)" }}>
                  ⚠ An endpoint already exists for {chain ? buildChainMetaByIndex(chain).name : ""} / {cfgIface}.
                </div>
              )}
            </div>
          )}

          {/* Step 3 — Upstreams */}
          {step === 3 && (
            <div style={{ display: "grid", gap: 10 }}>
              {/* Select all / deselect all */}
              {chainUpstreams.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 12, color: "var(--text-3)" }}>
                    {(selUpstreams || []).length} of {chainUpstreams.length} selected
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="gw-btn" style={{ fontSize: 11, padding: "3px 9px" }}
                      onClick={() => setSelUpstreams(chainUpstreams.map((p) => p.id))}>
                      Select all
                    </button>
                    <button className="gw-btn" style={{ fontSize: 11, padding: "3px 9px" }}
                      onClick={() => setSelUpstreams([])}>
                      Deselect all
                    </button>
                  </div>
                </div>
              )}
              {chainUpstreams.length === 0 ? (
                <div style={{ padding: "16px", borderRadius: 9, background: "var(--bg)", border: "1px solid var(--line)", textAlign: "center" }}>
                  <div style={{ fontSize: 13, color: "var(--text-3)", marginBottom: 6 }}>No upstreams for {chain ? buildChainMetaByIndex(chain).name : "this chain"} support {cfgIface}.</div>
                  <div style={{ fontSize: 11, color: "var(--text-4)" }}>Add a compatible upstream on the Upstreams page first.</div>
                </div>
              ) : (
                chainUpstreams.map((pv) => {
                  const on = (selUpstreams || []).includes(pv.id);
                  return (
                    <button key={pv.id} onClick={() => toggleUpstream(pv.id)} style={{
                      display: "flex", alignItems: "center", gap: 12, padding: "11px 14px",
                      borderRadius: 9, cursor: "pointer", fontFamily: "inherit", textAlign: "left", width: "100%",
                      border: "1px solid " + (on ? "rgba(255,57,0,0.3)" : "var(--line)"),
                      background: on ? "rgba(255,57,0,0.05)" : "var(--bg)",
                    }}>
                      <div style={{
                        width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                        border: "1.5px solid " + (on ? "var(--brand)" : "var(--line-2)"),
                        background: on ? "var(--brand)" : "transparent",
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}>
                        {on && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 2 }}>
                          <span style={{ fontSize: 13, fontWeight: 600 }}>{pv.name}</span>
                          {pv.role === "primary"
                            ? <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: "rgba(34,197,94,0.1)", color: "var(--ok)", border: "1px solid rgba(34,197,94,0.22)" }}>Primary</span>
                            : pv.role === "backup"
                            ? <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: "rgba(96,165,250,0.1)", color: "#60a5fa", border: "1px solid rgba(96,165,250,0.22)" }}>Backup</span>
                            : null}
                          {pv.status === "degraded" && <span style={{ fontSize: 10, color: "var(--warn)" }}>⚠ degraded</span>}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pv.url || "—"}</div>
                      </div>
                    </button>
                  );
                })
              )}
              {/* Read-only reality — the final actionable step of this wizard. */}
              <Hint type="warn">{READONLY_MSG}</Hint>
            </div>
          )}

        </div>

        {/* Foot */}
        <div className="gw-sheet__foot">
          <button className="gw-btn" onClick={() => {
            if (step === 1) onClose(); else setStep((s) => s - 1);
          }}>
            {step === 1 ? "Cancel" : "← Back"}
          </button>
          {step === 1 && (
            <button className="gw-btn gw-btn--primary" disabled={!chain} onClick={() => setStep(2)}>
              Continue →
            </button>
          )}
          {step === 2 && (
            <button className="gw-btn gw-btn--primary" onClick={() => setStep(3)}>
              Continue →
            </button>
          )}
          {step === 3 && (
            <button className="gw-btn gw-btn--primary" disabled title={READONLY_MSG}>
              Create endpoint
            </button>
          )}
        </div>

      </div>
    </div>
  );
}
