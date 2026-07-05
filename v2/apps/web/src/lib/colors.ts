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
