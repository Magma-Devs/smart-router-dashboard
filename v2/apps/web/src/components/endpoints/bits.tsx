"use client";

/* Endpoints page bits — ported verbatim from the design prototype
 * (page-endpoints.jsx: IFACES_DEF, IfaceTag, EpStepBar, UrlBlock) plus the
 * self-hosted endpoint row model (one row per router × interface from the
 * mounted values file). Local URLs are http://localhost:<port> — the
 * design's cloud hosts don't exist here. The design's genJwt/fmtLastUsed
 * helpers are deliberately NOT ported: we never fabricate tokens or
 * "Never"-style last-used claims; unknown values render "—". */

import type { RouterTopology } from "@sr/shared";
import { CopyButton } from "@/components/gateway/CopyButton";

/* ── Interface catalogue (design ids; wss ≙ config "websocket") ── */
export interface IfaceDef {
  id: string;
  label: string;
  color: string;
  desc: string;
  comingSoon?: boolean;
}

export const IFACES_DEF: IfaceDef[] = [
  { id: "jsonrpc",       label: "JSON-RPC",      color: "#60a5fa", desc: "HTTP POST — standard JSON-RPC" },
  { id: "wss",           label: "WebSocket",     color: "#34d399", desc: "WSS — persistent connection for subscriptions" },
  { id: "grpc",          label: "gRPC",          color: "#a78bfa", desc: "HTTP/2 — protobuf" },
  { id: "rest",          label: "REST",          color: "#fb923c", desc: "Cosmos LCD · Solana REST · chain-specific" },
  { id: "tendermintrpc", label: "Tendermint RPC", color: "#22d3ee", desc: "Tendermint / CometBFT RPC" },
];

/** Config api-interface → design tag id ("websocket" wears the wss tag). */
export function tagIdForIface(iface: string): string {
  return iface === "websocket" ? "wss" : iface;
}

/** Design tag id → config api-interface (for conflict/port lookups). */
export function configIfaceForTag(id: string): string {
  return id === "wss" ? "websocket" : id;
}

export function epLocalHttp(port: number): string { return `http://localhost:${port}`; }
export function epLocalWs(port: number): string { return `ws://localhost:${port}`; }

export function IfaceTag({ id }: { id: string }) {
  const tagId = tagIdForIface(id);
  const iface = IFACES_DEF.find((i) => i.id === tagId) || { label: id, color: "#888" };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", flexShrink: 0,
      padding: "2px 7px", borderRadius: 4, fontSize: 10, fontWeight: 600,
      background: iface.color + "18", color: iface.color,
      textTransform: "uppercase", letterSpacing: "0.05em",
    }}>{iface.label}</span>
  );
}

export function EpStepBar({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="gw-sheet__steps">
      {steps.map((s, i) => {
        const idx = i + 1, isDone = current > idx, isActive = current === idx;
        return (
          <div key={i} className={"gw-sheet__step" + (isActive ? " active" : "") + (isDone ? " done" : "")}>
            <span className="gw-sheet__step-num">{isDone ? "✓" : idx}</span>{s}
          </div>
        );
      })}
    </div>
  );
}

export function UrlBlock({ label, url }: { label: string; url: string }) {
  return (
    <div style={{ padding: "9px 11px", borderRadius: 7, background: "var(--bg)", border: "1px solid var(--line)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
        <span style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-3)" }}>{label}</span>
        <CopyButton text={url} />
      </div>
      <span className="gw-mono" style={{ fontSize: 11, color: "var(--text-2)", wordBreak: "break-all", display: "block" }}>{url}</span>
    </div>
  );
}

/* ─────────────────────────────────────────────
   Endpoint row model — one per (router, interface) from the live topology.
───────────────────────────────────────────── */
export interface EndpointNodeRef {
  name: string;
  isBackup: boolean;
  urlHost: string;
  addons: string[];
}

export interface EndpointRowModel {
  /** `${routerId}|${iface}` */
  id: string;
  routerId: string;
  spec: string;
  network: string;
  /** Raw config api-interface (jsonrpc, websocket, rest, tendermintrpc, grpc). */
  iface: string;
  /** Local listen port for this interface (SR_CONFIG only), else null. */
  port: number | null;
  /** Upstream node endpoints serving this interface. */
  nodes: EndpointNodeRef[];
}

export function buildEndpointRows(routers: RouterTopology[]): EndpointRowModel[] {
  const out: EndpointRowModel[] = [];
  for (const r of routers) {
    const ifaces = r.interfaces.length ? r.interfaces : [""];
    for (const rawIface of ifaces) {
      const iface = rawIface || "jsonrpc";
      const nodes: EndpointNodeRef[] = [];
      for (const n of r.nodes) {
        for (const e of n.endpoints) {
          if (e.interface !== rawIface) continue;
          nodes.push({ name: n.name, isBackup: n.isBackup, urlHost: e.urlHost, addons: e.addons });
        }
      }
      out.push({
        id: `${r.id}|${iface}`,
        routerId: r.id,
        spec: r.spec,
        network: r.network,
        iface,
        port: r.localPorts[rawIface] ?? r.localPorts[iface] ?? r.localPort,
        nodes,
      });
    }
  }
  return out;
}

/** Unique node names serving a row (the design's upstream count). */
export function upstreamCount(ep: EndpointRowModel): number {
  return new Set(ep.nodes.map((n) => n.name)).size;
}

/** True when any node serving this row carries an `archive` addon — gates
 *  the Try-now drawer's Archive tier for this specific endpoint. */
export function epHasArchive(ep: EndpointRowModel): boolean {
  return ep.nodes.some((n) => n.addons.includes("archive"));
}

/** Union of addon capabilities across the endpoint's upstreams, plus a `ws`
 *  marker when the endpoint's interface serves websockets. Feeds the
 *  CapabilityTags chips on the Endpoints page. */
export function epAddons(ep: EndpointRowModel): string[] {
  const set = new Set<string>();
  for (const n of ep.nodes) for (const a of n.addons) set.add(a);
  return [...set];
}

/** Whether this endpoint's interface is (or pairs with) a websocket transport
 *  — jsonrpc/tendermintrpc listeners also accept a ws upgrade. */
export function epHasWs(ep: EndpointRowModel): boolean {
  return (
    ep.iface.endsWith("-ws") ||
    ep.nodes.some((n) => n.urlHost.startsWith("ws://") || n.urlHost.startsWith("wss://"))
  );
}
