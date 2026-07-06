"use client";

import { useState, useSyncExternalStore, type CSSProperties } from "react";
import type { HealthState } from "@sr/shared";
import { CopyButton } from "@/components/gateway/CopyButton";
import {
  getCatalogVersion,
  getInterfaceConfig,
  isCatalogInterface,
  subscribeCatalog,
} from "./chain-methods";

/** SSR/hydration snapshot: always render as "catalog not loaded yet" so the
 *  server markup and the client's hydration pass agree; the store then bumps
 *  to the real version and re-renders with the generated catalog. */
const getServerCatalogVersion = () => 0;
import { IconZap, TryMeDrawer } from "./drawer";

interface EndpointRowProps {
  /** Lava spec label (`ETH1`, `SOLANA`, …). */
  spec: string;
  /** Network name from the topology (`mainnet`, `testnet`, …). */
  network: string;
  /** Interface id for this row — a `CatalogInterface` gets a Try-it button;
   *  anything else (e.g. `grpc` ports without a catalog) is copy-only. */
  iface: string;
  /** Left-column label (the human transport name). */
  label: string;
  /** Concrete local URL — `http://localhost:<port>` or
   *  `ws://localhost:<port>/websocket`. */
  url: string;
  /** Whether this chain's mounted config marks an `archive` addon. */
  hasArchive: boolean;
  /** Live health from /api/metrics/chains (omitted when unknown). */
  health?: HealthState;
}

const ROW_BASE: CSSProperties = {
  gap: 8,
  padding: "7px 10px",
  borderRadius: 6,
  transition: "background 0.12s ease, border-color 0.12s ease",
};

export function EndpointRow({
  spec,
  network,
  iface,
  label,
  url,
  hasArchive,
  health,
}: EndpointRowProps) {
  const [hovered, setHovered] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // The full spec-index catalog is a dynamically-imported ~590 KB JSON chunk
  // (see chain-methods.ts) — re-render when it lands so getInterfaceConfig
  // upgrades from the family fallback to the exact per-spec method list.
  useSyncExternalStore(subscribeCatalog, getCatalogVersion, getServerCatalogVersion);

  const catalogIface = isCatalogInterface(iface) ? iface : null;
  const cfg = catalogIface ? getInterfaceConfig(spec, catalogIface, hasArchive) : null;
  const canTry = catalogIface !== null && cfg !== null;
  const showActions = hovered || drawerOpen;

  return (
    <>
      <div
        className="gw-row"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          ...ROW_BASE,
          background: hovered ? "var(--hover-2)" : "var(--hover)",
          border: `1px solid ${drawerOpen ? "rgba(255,57,0,0.3)" : "var(--line)"}`,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 500,
            color: "var(--text-2)",
            flexShrink: 0,
            minWidth: 180,
          }}
        >
          {label}
        </span>
        <span
          className="gw-mono"
          style={{
            fontSize: 11,
            color: "var(--text-2)",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {url}
        </span>
        <div
          className="gw-row"
          style={{
            gap: 4,
            flexShrink: 0,
            opacity: showActions ? 1 : 0,
            transform: showActions ? "translateX(0)" : "translateX(4px)",
            transition: "opacity 0.15s ease, transform 0.15s ease",
            pointerEvents: showActions ? "auto" : "none",
          }}
        >
          {canTry && (
            <button
              type="button"
              className="gw-btn gw-btn--ghost"
              onClick={() => setDrawerOpen(true)}
              style={{
                padding: "3px 9px",
                fontSize: 11,
                gap: 5,
                whiteSpace: "nowrap",
                color: "var(--brand)",
                borderColor: "rgba(255,57,0,0.25)",
                background: drawerOpen ? "rgba(255,57,0,0.08)" : "transparent",
              }}
            >
              <IconZap size={11} /> Try it
            </button>
          )}
          <CopyButton text={url} />
        </div>
      </div>
      {drawerOpen && catalogIface && cfg && (
        <TryMeDrawer
          spec={spec}
          network={network}
          iface={catalogIface}
          cfg={cfg}
          endpointUrl={url}
          health={health}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </>
  );
}
