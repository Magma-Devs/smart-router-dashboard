"use client";

import { useState, useSyncExternalStore } from "react";
import type { HealthState } from "@sr/shared";
import {
  getCatalogVersion,
  getInterfaceConfig,
  isCatalogInterface,
  subscribeCatalog,
} from "./chain-methods";
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
  /** Concrete local URL — `http://localhost:<port>` (or ws:// for a WS row). */
  url: string;
  /** Whether this chain's mounted config marks an `archive` addon anywhere. */
  hasArchive: boolean;
  /** Live health from /api/metrics/chains (omitted when unknown). */
  health?: HealthState;
  /** Optional visibility control for hover-reveal parents (Endpoints rows). */
  visible?: boolean;
  /** Pin the relay to a specific provider via `lava-select-provider` (HTTP
   *  only). Set by the per-upstream Try-now so the call hits that upstream. */
  selectUpstream?: string;
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
  hasArchive,
  health,
  visible = true,
  selectUpstream,
}: TryNowButtonProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  // The full spec-index catalog is a dynamically-imported ~590 KB JSON chunk
  // (see chain-methods.ts) — re-render when it lands so getInterfaceConfig
  // upgrades from the family fallback to the exact per-spec method list.
  useSyncExternalStore(subscribeCatalog, getCatalogVersion, getServerCatalogVersion);

  const catalogIface = isCatalogInterface(iface) ? iface : null;
  const cfg = catalogIface ? getInterfaceConfig(spec, catalogIface, hasArchive) : null;
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
          health={health}
          selectUpstream={selectUpstream}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </>
  );
}
