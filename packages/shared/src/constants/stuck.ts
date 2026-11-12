/**
 * When a provider counts as STUCK on a block - the fleet's own alert rule
 * ("a provider is stuck on the same block", `sr-provider-stuck-<tenant>` in
 * Grafana), so a chart and a page say "stuck" at the moment the alert does.
 *
 * The rule: the provider's latest block did not change over the chain's quiet
 * window while the router's tip did, and that held for five more minutes. The
 * quiet window is how long the chain can rest between blocks: five minutes for
 * most, longer for the slow ones below. The lists are the alert's, copied; a
 * chain added to one there belongs in the same one here.
 */

/** How long the alert's condition must hold before it fires (`for: 5m`). */
export const STUCK_HOLD_SEC = 300;

/** The quiet window of every chain the alert doesn't list. */
export const STUCK_WINDOW_DEFAULT_SEC = 300;

const SLOW_CHAINS: ReadonlyArray<readonly [seconds: number, specs: readonly string[]]> = [
  [15 * 60, ["PLASMAT"]],
  [30 * 60, ["BASES", "DOGE", "STACKST", "TRAC", "ZCASH"]],
  [45 * 60, ["ARWEAVE", "ARWEAVET", "AVALANCHEP", "AVALANCHEPT", "DASH", "DASHT", "LTC", "MONERO", "MONEROT"]],
  [2 * 3600, ["MINA", "MINAT", "ZCASHT"]],
  [3 * 3600, ["BCH", "BCHT", "BTC", "BTCS", "BTCT", "BTCT4", "CANTON", "CANTONT"]],
];

const WINDOW_BY_SPEC: ReadonlyMap<string, number> = new Map(
  SLOW_CHAINS.flatMap(([seconds, specs]) => specs.map((s) => [s, seconds] as const)),
);

/** The chain's quiet window in seconds: no new block for this long, with the router's tip moving, is the alert's condition. */
export function stuckWindowSec(spec: string): number {
  return WINDOW_BY_SPEC.get(spec.toUpperCase()) ?? STUCK_WINDOW_DEFAULT_SEC;
}

/** How long a provider sits on one block before the alert fires: the quiet window, then the hold. */
export function stuckAfterSec(spec: string): number {
  return stuckWindowSec(spec) + STUCK_HOLD_SEC;
}

/** A stretch a provider spent on one block, long enough for the alert: points `from`..`to` of its series. */
export interface StuckStretch {
  /** The first point at the block it stayed on - where it stopped. */
  from: number;
  /** The last point still at that block. */
  to: number;
  /** The block it stayed on. */
  block: number;
}

/**
 * The stretches of `tips` (one provider's latest block per point, NaN where it
 * has none) that the alert would have fired on: the same block for at least
 * `afterSec` (`stuckAfterSec`), while `reference` (the tip the chain reached,
 * per point - the highest of every provider's) moved on. Points are `stepSec`
 * apart. A chain that itself produced no block in the stretch is quiet, not a
 * stuck provider, and a missing point ends a stretch: no data is not a
 * frozen tip.
 */
export function stuckStretches(tips: readonly number[], reference: readonly number[], stepSec: number, afterSec: number): StuckStretch[] {
  const out: StuckStretch[] = [];
  if (!(stepSec > 0)) return out;
  let i = 0;
  while (i < tips.length) {
    const block = tips[i]!;
    if (!Number.isFinite(block)) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < tips.length && tips[j + 1] === block) j++;
    const refFrom = reference[i], refTo = reference[j];
    const chainMoved = refFrom != null && refTo != null && Number.isFinite(refFrom) && Number.isFinite(refTo) && refTo > refFrom;
    if ((j - i) * stepSec >= afterSec && chainMoved) out.push({ from: i, to: j, block });
    i = j + 1;
  }
  return out;
}
