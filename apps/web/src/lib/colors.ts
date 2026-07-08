/* Color maps — ported verbatim from the design prototype
   (page-overview.jsx lines 4–14). */

export const CHAIN_CLR: Record<string, string> = { Ethereum: "#627EEA", Solana: "#14F195", Arbitrum: "#28A0F0", Base: "#0052FF", Polygon: "#8247E5", Other: "#52525b" };

export const ERR_CLR: Record<string, string> = {
  client_error: "#64748b", server_error: "#ef4444", timeout: "#f97316",
  rate_limited: "#fbbf24", stale_data: "#a78bfa", upstream_unavailable: "#dc2626",
};

export const ERR_LBL: Record<string, string> = {
  client_error: "Client 4xx", server_error: "Server 5xx", timeout: "Timeout",
  rate_limited: "Rate limited", stale_data: "Stale data", upstream_unavailable: "Unavail.",
};

export const ERR_HANDLED_CLR: string[] = ["var(--ok)", "var(--info)", "var(--warn)", "var(--text-3)"];

/* ── Uptime / availability thresholds (single source of truth) ──────────────
   Percentage boundaries for the green / amber / red status colour used on every
   uptime + availability figure (upstream cards, roster, deep-dive, routers).
     green  (ok)   ≥ 99.9%
     amber  (warn) ≥ 99%   (and < 99.9%)
     red    (err)  < 99%                                                       */
export const UPTIME_OK_PCT = 99.9;
export const UPTIME_WARN_PCT = 99;

/** CSS colour var for an availability/uptime PERCENTAGE (0..100). */
export function uptimeColor(pct: number | null): string {
  if (pct === null) return "var(--text-4)";
  if (pct >= UPTIME_OK_PCT) return "var(--ok)";
  if (pct >= UPTIME_WARN_PCT) return "var(--warn)";
  return "var(--err)";
}

/** Same, for a 0..1 FRACTION (some callers hold uptime as a ratio). */
export function uptimeColorFrac(frac: number | null): string {
  return uptimeColor(frac === null ? null : frac * 100);
}
