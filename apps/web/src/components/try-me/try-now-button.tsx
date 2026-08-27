"use client";

import { useState, useSyncExternalStore } from "react";
import type { HealthState } from "@sr/shared";
import {
  getCatalogVersion,
  getInterfaceConfig,
  isCatalogInterface,
  subscribeCatalog,
} from "./chain-methods";
import type { DirectTarget } from "./direct-request";
import type { UpstreamTier } from "./pin-support";
import { IconZap, TryMeDrawer } from "./drawer";

/** SSR/hydration snapshot: render as "catalog not loaded yet" so server and
 *  client hydration agree; the store bumps to the real version afterwards. */
const getServerCatalogVersion = () => 0;

interface TryNowButtonProps {
  /** Lava spec label (`ETH1`, `SOLANA`, …). */
  spec: string;
  /** Network name from the topology (`mainnet`, `testnet`, …). */
  network: string;
  /** Raw config interface id for this endpoint row. */
  iface: string;
  /** Concrete address for the HTTP transport — the published gateway URL, or
   *  `http://localhost:<port>` on an SR_CONFIG mount. */
  url: string;
  /** The same endpoint's WebSocket address, when it serves one. Set ⇒ the
   *  drawer offers a HTTP / WebSocket toggle. */
  wsUrl?: string | null;
  /** Open the drawer on the WebSocket transport (a ws-flagged upstream row). */
  initialTransport?: "http" | "ws";
  /** Add-ons the mounted config declares on this endpoint's upstreams
   *  (`archive`, `debug`, `trace`). Tiers the deployment can't serve are not
   *  offered — the router answers "No Providers For Addon" for those. */
  addons: readonly string[];
  /** Live health from /api/metrics/chains (omitted when unknown). */
  health?: HealthState;
  /** Optional visibility control for hover-reveal parents (Endpoints rows). */
  visible?: boolean;
  /** Pin the relay to a specific provider via `lava-select-provider` (HTTP
   *  only). Set by the per-upstream Try-now so the call hits that upstream. */
  selectUpstream?: string;
  /** Identity of the upstream endpoint(s) behind this row, enabling the
   *  drawer's "Direct to upstream" mode — the api dials the upstream itself,
   *  with the router out of the path. Null on router-level rows (Endpoints),
   *  which have no single upstream to bypass to. */
  directTarget?: DirectTarget | null;
  /** Which router pool this row's node sits in. A backup can't be pinned, so
   *  the drawer says so and opens on the direct leg. Per ROW, not per
   *  upstream: one node can be primary on one chain and backup on another. */
  upstreamTier?: UpstreamTier;
}

/**
 * Self-contained "Try now" affordance: a small brand-accented button that
 * opens the TryMeDrawer against a local router listen port. Renders nothing
 * when the interface has no method catalog (e.g. a bare grpc port), so a
 * caller can drop it into any endpoint row unconditionally.
 *
 * Extracted from the former standalone Live-test page so the same request
 * console lives inline on the Endpoints page.
 */
export function TryNowButton({
  spec,
  network,
  iface,
  url,
  wsUrl = null,
  initialTransport = "http",
  addons,
  health,
  visible = true,
  selectUpstream,
  directTarget = null,
  upstreamTier = "primary",
}: TryNowButtonProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  // The full spec-index catalog is a dynamically-imported ~590 KB JSON chunk
  // (see chain-methods.ts) — re-render when it lands so getInterfaceConfig
  // upgrades from the family fallback to the exact per-spec method list.
  useSyncExternalStore(subscribeCatalog, getCatalogVersion, getServerCatalogVersion);

  const catalogIface = isCatalogInterface(iface) ? iface : null;
  const cfg = catalogIface ? getInterfaceConfig(spec, catalogIface, addons) : null;
  if (!catalogIface || !cfg) return null;

  return (
    <>
      <button
        type="button"
        className="gw-btn gw-btn--ghost"
        onClick={(e) => {
          e.stopPropagation();
          setDrawerOpen(true);
        }}
        title="Fire a live request against this endpoint"
        style={{
          padding: "3px 9px",
          fontSize: 11,
          gap: 5,
          whiteSpace: "nowrap",
          flexShrink: 0,
          color: "var(--brand)",
          borderColor: "rgba(255,57,0,0.25)",
          background: drawerOpen ? "rgba(255,57,0,0.08)" : "transparent",
          opacity: visible || drawerOpen ? 1 : 0,
          transition: "opacity 0.15s ease",
          pointerEvents: visible || drawerOpen ? "auto" : "none",
        }}
      >
        <IconZap size={11} /> Try now
      </button>
      {drawerOpen && (
        <TryMeDrawer
          spec={spec}
          network={network}
          iface={catalogIface}
          cfg={cfg}
          endpointUrl={url}
          wsUrl={wsUrl}
          initialTransport={initialTransport}
          health={health}
          selectUpstream={selectUpstream}
          directTarget={directTarget}
          upstreamTier={upstreamTier}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </>
  );
}
