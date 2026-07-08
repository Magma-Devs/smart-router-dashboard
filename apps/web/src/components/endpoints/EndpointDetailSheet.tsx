"use client";

/* Endpoint detail sheet — ported from the design prototype
 * (page-endpoints.jsx EndpointDetailSheet). SELF-HOSTED REALITY:
 *  · URLs are the local listen port (http/ws://localhost:<port>) plus each
 *    upstream node's urlHost list under "Served by";
 *  · JWT management (reissue / revoke / reveal) is a Magma-Cloud feature —
 *    the controls render disabled with an honest hint and the masked value
 *    is "—" (never a fabricated token);
 *  · "Served by" edit mode renders fully but Save is disabled (read-only
 *    config), as is the delete confirmation's commit. */

import { useEffect, useMemo, useState } from "react";
import type { RouterTopology } from "@sr/shared";
import { buildChainMetaByIndex } from "@sr/shared";
import { labelStyle } from "@/lib/styles";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { CloudNotice } from "@/components/gateway/CloudNotice";
import { JWT_CLOUD_MSG, READONLY_MSG, type UpstreamRow } from "@/components/upstreams/catalog";
import {
  IfaceTag,
  UrlBlock,
  epLocalHttp,
  epLocalWs,
  type EndpointRowModel,
} from "@/components/endpoints/bits";

interface NodeGroup { name: string; isBackup: boolean; hosts: string[] }

export function EndpointDetailSheet({ open, ep, router, onClose, upstreams }: {
  open: boolean;
  ep: EndpointRowModel | null;
  router: RouterTopology | null;
  onClose: () => void;
  upstreams: UpstreamRow[];
}) {
  const [editingUpstreams, setEditingUpstreams] = useState(false);
  const [localUpstreamIds, setLocalUpstreamIds] = useState<string[]>([]);

  /* One entry per upstream node (its urlHost list joined for display). */
  const nodeGroups = useMemo<NodeGroup[]>(() => {
    const m = new Map<string, NodeGroup>();
    for (const n of ep?.nodes ?? []) {
      let g = m.get(n.name);
      if (!g) { g = { name: n.name, isBackup: n.isBackup, hosts: [] }; m.set(n.name, g); }
      if (n.urlHost && !g.hosts.includes(n.urlHost)) g.hosts.push(n.urlHost);
    }
    return [...m.values()];
  }, [ep]);

  useEffect(() => {
    if (open) {
      setEditingUpstreams(false);
      setLocalUpstreamIds(nodeGroups.map((n) => n.name));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ep?.id]);

  if (!open || !ep) return null;

  const chain = buildChainMetaByIndex(ep.spec);
  const host = ep.port !== null ? `localhost:${ep.port}` : "—";
  const wsPort = router?.localPorts["websocket"] ?? null;
  const upstreamByName = (name: string): UpstreamRow | undefined => upstreams.find((p) => p.id === name);
  const statusTagCls = (s: string | undefined) =>
    "gw-tag" + (s === "healthy" ? " gw-tag--ok" : s === "degraded" ? " gw-tag--warn" : "");

  return (
    <div className="gw-sheet-bg" onClick={onClose}>
      <div className="gw-sheet gw-sheet--wide" onClick={(e) => e.stopPropagation()}>

        {/* Head */}
        <div className="gw-sheet__head">
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10, flex: 1, minWidth: 0 }}>
            <ChainBadge spec={ep.spec} size={30} />
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                <p className="gw-sheet__title" style={{ margin: 0 }}>{chain.name}</p>
                <IfaceTag id={ep.iface} />
              </div>
              <p className="gw-sheet__sub" style={{ margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{host}</p>
              <p style={{ margin: "3px 0 0", fontSize: 11, color: "var(--text-4)" }}>
                Last used — · Created —
              </p>
            </div>
          </div>
          <button className="gw-btn gw-btn--ghost" style={{ padding: 5, flexShrink: 0 }} onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* Body */}
        <div className="gw-sheet__body" style={{ display: "grid", gap: 14, alignContent: "start" }}>

          {/* URLs + Upstreams */}
          <div>
            <div style={{ ...labelStyle, marginBottom: 7 }}>Endpoint URL</div>
            <div style={{ display: "grid", gap: 5 }}>
              {ep.port === null ? (
                <div style={{ fontSize: 12, color: "var(--text-3)" }}>No local listen port in the mounted config.</div>
              ) : ep.iface === "websocket" ? (
                <UrlBlock label="WebSocket" url={epLocalWs(ep.port)} />
              ) : (
                <UrlBlock label="HTTP POST" url={epLocalHttp(ep.port)} />
              )}
              {ep.iface === "jsonrpc" && wsPort !== null && <UrlBlock label="WSS" url={epLocalWs(wsPort)} />}
            </div>

            {/* Participating upstreams */}
            <div style={{ marginTop: 12 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
                <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-3)" }}>Served by</div>
                {!editingUpstreams
                  ? <button className="gw-btn" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => setEditingUpstreams(true)}>Edit</button>
                  : <div style={{ display: "flex", gap: 6 }}>
                      <button className="gw-btn" style={{ fontSize: 11, padding: "2px 8px" }}
                        onClick={() => { setEditingUpstreams(false); setLocalUpstreamIds(nodeGroups.map((n) => n.name)); }}>Cancel</button>
                      <button className="gw-btn gw-btn--primary" style={{ fontSize: 11, padding: "2px 8px" }}
                        disabled title={READONLY_MSG}>Save</button>
                    </div>
                }
              </div>

              {editingUpstreams ? (
                /* Edit mode — checkboxes for all compatible upstreams */
                (() => {
                  const compatible = upstreams.filter((p) =>
                    p.chains.includes(ep.spec) &&
                    (!p.interfaces.length || p.interfaces.includes(ep.iface))
                  );
                  const toggle = (id: string) => setLocalUpstreamIds((prev) =>
                    prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
                  );
                  return (
                    <div style={{ display: "grid", gap: 5 }}>
                      <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
                        <button className="gw-btn" style={{ fontSize: 10, padding: "2px 8px" }}
                          onClick={() => setLocalUpstreamIds(compatible.map((p) => p.id))}>Select all</button>
                        <button className="gw-btn" style={{ fontSize: 10, padding: "2px 8px" }}
                          onClick={() => setLocalUpstreamIds([])}>Deselect all</button>
                      </div>
                      {compatible.length === 0 ? (
                        <div style={{ fontSize: 12, color: "var(--text-3)", padding: "8px 0" }}>No compatible upstreams for this chain and interface.</div>
                      ) : compatible.map((pv) => {
                        const on = localUpstreamIds.includes(pv.id);
                        return (
                          <button key={pv.id} onClick={() => toggle(pv.id)} style={{
                            display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
                            borderRadius: 8, cursor: "pointer", fontFamily: "inherit", textAlign: "left", width: "100%",
                            border: "1px solid " + (on ? "rgba(255,57,0,0.3)" : "var(--line)"),
                            background: on ? "rgba(255,57,0,0.05)" : "var(--bg)",
                          }}>
                            <div style={{
                              width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                              border: "1.5px solid " + (on ? "var(--brand)" : "var(--line-2)"),
                              background: on ? "var(--brand)" : "transparent",
                              display: "flex", alignItems: "center", justifyContent: "center",
                            }}>
                              {on && <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <span style={{ fontSize: 12, fontWeight: 600 }}>{pv.name}</span>
                                {pv.role === "primary" && <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 3, background: "rgba(34,197,94,0.1)", color: "var(--ok)" }}>Primary</span>}
                                {pv.role === "backup" && <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 3, background: "rgba(96,165,250,0.1)", color: "#60a5fa" }}>Backup</span>}
                              </div>
                              <div style={{ fontSize: 10, color: "var(--text-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1 }}>{pv.url || "—"}</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  );
                })()
              ) : (
                /* Read mode — the config's upstream nodes + their urlHost list */
                <div style={{ display: "grid", gap: 5 }}>
                  {nodeGroups.length === 0 ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 11px", borderRadius: 7,
                      background: "rgba(239,68,68,0.05)", border: "1px solid rgba(239,68,68,0.18)" }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--err)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                      <span style={{ fontSize: 12, color: "var(--err)" }}>No upstreams — endpoint will return errors.</span>
                    </div>
                  ) : (
                    nodeGroups.map((n) => {
                      const pv = upstreamByName(n.name);
                      return (
                        <div key={n.name} style={{ padding: "7px 10px", borderRadius: 7, background: "var(--hover)", border: "1px solid var(--line)" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                            <span style={{ fontSize: 12, fontWeight: 500, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.name}</span>
                            {!n.isBackup && <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: "rgba(34,197,94,0.1)", color: "var(--ok)", border: "1px solid rgba(34,197,94,0.2)", flexShrink: 0 }}>Primary</span>}
                            {n.isBackup && <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: "rgba(96,165,250,0.1)", color: "#60a5fa", border: "1px solid rgba(96,165,250,0.2)", flexShrink: 0 }}>Backup</span>}
                            <IfaceTag id={ep.iface} />
                            <span className={statusTagCls(pv?.status)} style={{ fontSize: 10, padding: "1px 6px", flexShrink: 0 }}>
                              {pv?.status ?? "—"}
                            </span>
                          </div>
                          {n.hosts.length > 0 && (
                            <div className="gw-mono" style={{ fontSize: 10, color: "var(--text-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 3 }}>
                              {n.hosts.join(" · ")}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Authentication — Magma Cloud feature, disabled-honest */}
          <div>
            <div style={{ ...labelStyle, marginBottom: 7 }}>Authentication</div>
            <div style={{ padding: "11px 13px 9px", borderRadius: 9, background: "var(--bg)", border: "1px solid var(--line)" }}>
              <div style={{ display: "grid", gap: 9 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, color: "var(--text-3)" }}>Authorization: Bearer</span>
                  <span className="gw-mono" style={{ fontSize: 14, fontWeight: 600, color: "var(--text-2)", letterSpacing: "0.04em" }}>
                    —
                  </span>
                </div>
                <div style={{ display: "flex", gap: 7 }}>
                  <button className="gw-btn" style={{ fontSize: 12, padding: "5px 11px" }}
                    disabled title={JWT_CLOUD_MSG}>
                    Reissue token
                  </button>
                  <button className="gw-btn gw-btn--danger" style={{ fontSize: 12, padding: "5px 11px" }}
                    disabled title={JWT_CLOUD_MSG}>
                    Revoke
                  </button>
                </div>
                <CloudNotice feature="JWT management" detail="no tokens exist on this self-hosted deployment — local endpoints answer unauthenticated on their listen port." compact />
              </div>
            </div>
          </div>

        </div>

        {/* Foot — endpoints come from the read-only mounted config, so there
            is no delete action; edit the values file to remove one. */}
        <div className="gw-sheet__foot">
          <span style={{ fontSize: 11, color: "var(--text-4)", flex: 1 }}>Defined in the mounted values file · read-only</span>
          <button className="gw-btn gw-btn--primary" onClick={onClose}>Done</button>
        </div>

      </div>
    </div>
  );
}
