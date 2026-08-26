"use client";

/* Skel — the ONE loading vocabulary for the dashboard.
 *
 * The Metrics page fetches from seven endpoints that resolve at different
 * times, so it needs a loading state that composes: seven spinners would read
 * as seven separate things happening, and a single page-level spinner would
 * make the fast panels wait on the slowest (`routers-rollup`, which fans out
 * to ~8 Prometheus queries per router). So every panel shows a ghost of its
 * OWN content, and the ghosts share one keyframe and one duration from
 * `globals.css` — mounted in the same frame, they sweep in phase and read as
 * a single surface settling.
 *
 * Two rules the call sites depend on:
 *
 *  1. **Ghosts are content-shaped and content-sized.** A bar where the number
 *     goes, in the number's box. Nothing moves when the data lands, which is
 *     what separates a skeleton from a spinner that then reflows the page.
 *  2. **First load only.** These render on SWR's `isLoading` (no data yet),
 *     never on `isValidating` — the panels poll every 15s and a ghost on every
 *     poll would strobe. A refetch that already has numbers keeps them and
 *     uses `<Refreshing>` instead.
 *
 * They also exist to stop the page ASSERTING things while it loads. Before
 * this, `data === undefined` fell through to the honest-empty branch, so a
 * loading Metrics page said "cache not enabled on this build", "No upstreams
 * configured yet." and — worst — a green tick reading "No errors on this chain
 * in the selected window." Those are claims about the deployment, and we
 * hadn't heard back yet. See the honesty contract in CLAUDE.md.
 */

import type { CSSProperties, ReactNode } from "react";

/** A single ghost bar. `w`/`h` are the box the real content will occupy. */
export function Skel({ w = "100%", h = 12, r = 5, style }: {
  w?: number | string;
  h?: number;
  /** Corner radius; 999 for pills/dots. */
  r?: number;
  style?: CSSProperties;
}) {
  return (
    <span
      className="gw-skel"
      aria-hidden
      style={{ width: w, height: h, borderRadius: r, ...style }}
    />
  );
}

/**
 * The ghost for one of the big KPI numbers (the 22–24px `gw-tnum` figures on
 * HeroPanel / CrossValidation / WebSocketPanel). Sized to the digits, not to
 * the column — a full-width bar reads as a loading *card* and overstates how
 * much is missing.
 */
export function SkelValue({ w = 92, h = 22 }: {
  w?: number;
  /** The LINE BOX the real figure occupies (font-size × line-height), so the
   *  card keeps its exact height. The bar itself is drawn shorter and centred
   *  inside it — a ghost as tall as the digits reads as a filled block. */
  h?: number;
}) {
  return (
    <span aria-hidden style={{ display: "flex", alignItems: "center", height: h }}>
      <Skel w={w} h={Math.round(h * 0.7)} r={5} />
    </span>
  );
}

/** The ghost for a small caption / sub-line under a value. */
export function SkelLine({ w = 140, h = 9 }: { w?: number | string; h?: number }) {
  return <Skel w={w} h={h} r={4} />;
}

export interface SkelCol {
  /** Ghost width in the cell. A number is px; a string is any CSS length. */
  w?: number | string;
  align?: "left" | "right";
}

/**
 * Ghost rows for a `gw-table` body, so a loading table keeps its height and
 * the header/pager don't jump when rows arrive.
 *
 * Widths are jittered per row so the block doesn't read as a barcode — from
 * the row index, never `Math.random()`, which would differ between the server
 * render and hydration.
 */
export function SkelRows({ cols, rows = 5, cellPadY = 13 }: {
  cols: SkelCol[];
  rows?: number;
  cellPadY?: number;
}) {
  // Deterministic, so SSR and client agree. Reads as organic, repeats after 5.
  const JITTER = [1, 0.82, 0.93, 0.74, 0.88];
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <tr key={i}>
          {cols.map((c, j) => {
            const base = c.w ?? "70%";
            const f = JITTER[(i + j) % JITTER.length]!;
            const w = typeof base === "number" ? Math.round(base * f) : base;
            return (
              <td key={j} style={{ padding: `${cellPadY}px 12px` }}>
                <span style={{ display: "flex", justifyContent: c.align === "right" ? "flex-end" : "flex-start" }}>
                  <Skel w={w} h={10} />
                </span>
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

/**
 * The cue for a panel that HAS data and is revalidating — a breathing dot, not
 * a spinner. The numbers on screen are still the last real answer, so the
 * strongest thing we should say is "there may be a newer one coming".
 *
 * This is also the answer to `keepPreviousData: true`: changing the window or
 * the chain re-fetches while the OLD numbers stay up, and without a cue the
 * page silently shows one window's data under another window's label.
 */
export function Refreshing({ show, label = "Refreshing" }: { show: boolean; label?: string }) {
  if (!show) return null;
  return (
    <span
      title={label}
      aria-label={label}
      className="gw-refreshing"
      style={{
        display: "inline-block", width: 6, height: 6, borderRadius: 999,
        background: "var(--text-4)", flexShrink: 0,
      }}
    />
  );
}

/**
 * Swap between a ghost and the real thing at one call site.
 * `loading` should be SWR's `isLoading` — see the "first load only" rule above.
 */
export function Loading({ loading, skeleton, children }: {
  loading: boolean;
  skeleton: ReactNode;
  children: ReactNode;
}) {
  return <>{loading ? skeleton : children}</>;
}
