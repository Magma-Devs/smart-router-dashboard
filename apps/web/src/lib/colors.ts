/* Color maps — chain colors ported from the design prototype; series and
   percentile colors come from the validated tokens in globals.css. */

/* ── Categorical series palette ──────────────────────────────────────────────
   ONE palette for every "which series is this" color in the app (upstream
   mixes, read/write/batch splits, score types …). Slots are theme-aware CSS
   variables validated for colorblind separation + surface contrast in BOTH
   themes (see globals.css). Rules:
     - assign in sequence from slot 1 — never skip, never re-sort by rank
     - never cycle: a 9th series folds into "Other" (SERIES_OTHER)
     - status colors (--ok/--warn/--err) are reserved for series that MEAN
       good/bad — never for identity                                         */
export const SERIES: readonly string[] = [
  "var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)",
  "var(--series-5)", "var(--series-6)", "var(--series-7)", "var(--series-8)",
];
export const SERIES_OTHER = "var(--series-other)";

/** Slot color for series index i; anything past the 8 slots is "Other". */
export function seriesColor(i: number): string {
  return SERIES[i] ?? SERIES_OTHER;
}

/* Color follows the ENTITY, not its row number: a chain filter or window
   switch that prunes the upstream list must not repaint the survivors. Slots
   are handed out per upstream name on first appearance and held for the whole
   browser session; the 9th+ distinct name shares the non-identity gray. */
const SLOT_BY_UPSTREAM = new Map<string, string>();
export function upstreamSlot(name: string): string {
  let c = SLOT_BY_UPSTREAM.get(name);
  if (c === undefined) {
    c = SLOT_BY_UPSTREAM.size < SERIES.length ? SERIES[SLOT_BY_UPSTREAM.size]! : SERIES_OTHER;
    SLOT_BY_UPSTREAM.set(name, c);
  }
  return c;
}

/* Ordinal percentile ramp — p50/p95/p99 are ORDERED, so they take one hue at
   three lightness steps (validated --ordinal), not three different hues. */
export const PCTL_CLR = { p50: "var(--ord-1)", p95: "var(--ord-2)", p99: "var(--ord-3)" } as const;

export const CHAIN_CLR: Record<string, string> = { Ethereum: "#627EEA", Solana: "#14F195", Arbitrum: "#28A0F0", Base: "#0052FF", Polygon: "#8247E5", Other: "var(--series-other)" };

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
