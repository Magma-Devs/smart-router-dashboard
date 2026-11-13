/**
 * The Errors tab's incidents: errors batched by when they arrive, so a busy
 * week of error rows reads as a few lines a day (MAG-5263).
 *
 * The model, decided from 7 days of production errors (failed tries and
 * error replies per chain and provider, at 5-minute steps):
 *  - A stretch is HOT for one chain and provider when its count reaches 3x
 *    its own usual level (the median over the read) and a floor - 10 failed
 *    tries or 50 error replies per 5 minutes. The multiplier barely changed
 *    the result between 2x and 5x; the floor decided it.
 *  - A burst holds at least twice that floor in all - 20 failed tries or 100
 *    error replies - whatever the step it was read at.
 *  - Hot stretches of one provider join, across chains, while the quiet gap
 *    between them is 15 minutes or less: an INCIDENT. 5 minutes split one
 *    problem in two; 30 minutes glued separate ones.
 *  - Two or more providers of one chain hot at the same time are the chain
 *    (or the clients' traffic), not a provider: one CHAIN-WIDE line.
 *  - The same cause again within 3 hours is one line with waves. Three waves
 *    or more read as RECURRING. One wave of 6 hours or more is LONG-RUNNING.
 *  - A chain and provider with errors in more than half of its stretches is
 *    ALWAYS PRESENT: one line with its usual rate, an incident only when it
 *    jumps.
 */

export type ErrorIncidentKind = "failed" | "reply";
export type ErrorIncidentShape = "incident" | "chain-wide" | "recurring" | "long-running";

/** One chain and provider's count per stretch: failed tries, or error replies. */
export interface ErrorIncidentSeries {
  kind: ErrorIncidentKind;
  spec: string;
  provider: string;
  /** [unix seconds, count in the stretch ending there]; a missing stretch counts 0. */
  points: [number, number][];
}

export interface ErrorIncidentWave {
  /** First and last stretch of the wave, unix seconds (the stretch's end). */
  start: number;
  end: number;
  count: number;
}

export interface ErrorIncidentLine {
  key: string;
  kind: ErrorIncidentKind;
  shape: ErrorIncidentShape;
  /** The provider that failed; every provider of the chain for a chain-wide line. */
  providers: string[];
  /** The chains it touched, the most errors first. */
  chains: { spec: string; count: number }[];
  start: number;
  end: number;
  count: number;
  /** The highest count in one stretch. */
  peak: number;
  waves: ErrorIncidentWave[];
  /** Its last stretch is the newest one read. */
  ongoing: boolean;
}

export interface SteadyError {
  kind: ErrorIncidentKind;
  spec: string;
  provider: string;
  /** The usual count per minute (median over the read). */
  perMinute: number;
  /** Share of stretches with any error, 0..1. */
  presence: number;
}

/** `GET /api/metrics/error-incidents`: the lines over the page window. */
export interface ErrorIncidentsReport {
  /** The page window: lines ending before `from` are left out. */
  from: number;
  to: number;
  /** The stretch the counts were read at, seconds. */
  stepSec: number;
  lines: ErrorIncidentLine[];
  steady: SteadyError[];
  /** False when the store refused a read; `failed` names which. */
  available: boolean;
  failed: ErrorIncidentKind[];
}

/** The read behind a window: its step (1 minute up to 3 hours, 5 up to 7 days, 30 beyond), and at least a day back for the usual level. */
export function errorIncidentsRead(rangeSeconds: number): { stepSec: number; readSeconds: number } {
  const stepSec = rangeSeconds <= 3 * 3600 ? 60 : rangeSeconds <= 7 * 86400 ? 300 : 1800;
  return { stepSec, readSeconds: Math.max(rangeSeconds, 86400) };
}

/**
 * Windows longer than this read the failed tries from the store's recorded
 * series, where it has them for the whole read (`qFailedTriesBySpecProviderRecorded`):
 * a month of the raw failed counters on a large deployment is a read of
 * seconds, near the store's timeout. Error replies, and every shorter window,
 * read the raw counters.
 */
export const ERROR_INCIDENTS_RECORDED_ABOVE_SEC = 7 * 86400;

/** The thresholds, named, so the api and the docs say the same. */
export const ERROR_INCIDENT_RULES = {
  multiplier: 3,
  /** Per 5 minutes; scaled to the read's step. */
  floorPer5Min: { failed: 10, reply: 50 } as Record<ErrorIncidentKind, number>,
  /** A burst's least size in all, whatever the step: twice the 5-minute floor. */
  minCount: { failed: 20, reply: 100 } as Record<ErrorIncidentKind, number>,
  gapSec: 15 * 60,
  repeatSec: 3 * 3600,
  longSec: 6 * 3600,
  recurringWaves: 3,
  steadyPresence: 0.5,
} as const;

/** The median of a non-empty run of counts (a typed array sorts by value, fast). */
const median = (xs: Float64Array): number => {
  const s = xs.slice().sort();
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Plain string order, so ties come out the same whatever order the store listed the series in. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Chains by count, the most first; a tie by name. */
const byCount = (a: [string, number], b: [string, number]): number => b[1] - a[1] || cmp(a[0], b[0]);
/** The chain with the most errors in a burst. */
const mainOf = (e: { chains: Map<string, number> }): string => [...e.chains].sort(byCount)[0]![0];

interface Hot { t: number; kind: ErrorIncidentKind; spec: string; provider: string; v: number }
interface Episode { kind: ErrorIncidentKind; providers: Set<string>; chains: Map<string, number>; start: number; end: number; count: number; peak: number }

/**
 * The incident lines and always-present errors in `series`, read at
 * `stepSec` over `[from, to]`. Lines that end by `windowFrom` are left
 * out: the read may reach further back than the window, for the usual level.
 * A point is read on the grid `from + k * stepSec`; one off it is ignored,
 * and a stretch with no point counts 0. The answer is the same whatever
 * order `series` comes in.
 */
export function detectErrorIncidents(series: ErrorIncidentSeries[], stepSec: number, from: number, to: number, windowFrom = from): { lines: ErrorIncidentLine[]; steady: SteadyError[] } {
  const R = ERROR_INCIDENT_RULES;
  if (!(stepSec > 0) || !(to >= from)) return { lines: [], steady: [] };
  const stretches = Math.max(1, Math.floor((to - from) / stepSec) + 1);
  const scale = stepSec / 300;
  const hot: Hot[] = [];
  const steady: SteadyError[] = [];
  for (const s of series) {
    // One slot per stretch of the read: a week of 5-minute stretches over
    // hundreds of series stays a few milliseconds.
    const values = new Float64Array(stretches);
    for (const [t, v] of s.points) {
      const k = (t - from) / stepSec;
      if (Number.isInteger(k) && k >= 0 && k < stretches) values[k] = v;
    }
    const usual = median(values);
    const floor = Math.max(1, R.floorPer5Min[s.kind] * scale);
    let present = 0;
    for (let k = 0; k < stretches; k++) {
      const v = values[k]!;
      if (v > 0) present++;
      if (v >= floor && v >= R.multiplier * usual) hot.push({ t: from + k * stepSec, kind: s.kind, spec: s.spec, provider: s.provider, v });
    }
    const presence = present / stretches;
    if (presence > R.steadyPresence) steady.push({ kind: s.kind, spec: s.spec, provider: s.provider, perMinute: usual / (stepSec / 60), presence });
  }

  // 1. Hot stretches of one provider (one kind), across chains, while the gap is short.
  const gap = Math.max(R.gapSec, 2 * stepSec);
  const byProvider = new Map<string, Hot[]>();
  for (const h of hot) {
    const k = `${h.kind}|${h.provider}`;
    (byProvider.get(k) ?? byProvider.set(k, []).get(k)!).push(h);
  }
  const episodes: Episode[] = [];
  for (const items of byProvider.values()) {
    items.sort((a, b) => a.t - b.t);
    let cur: Episode | null = null;
    for (const h of items) {
      if (cur && h.t - cur.end <= gap) {
        cur.end = Math.max(cur.end, h.t);
      } else {
        if (cur) episodes.push(cur);
        cur = { kind: h.kind, providers: new Set([h.provider]), chains: new Map(), start: h.t, end: h.t, count: 0, peak: 0 };
      }
      cur.count += h.v;
      cur.peak = Math.max(cur.peak, h.v);
      cur.chains.set(h.spec, (cur.chains.get(h.spec) ?? 0) + h.v);
    }
    if (cur) episodes.push(cur);
  }
  // A count in all, so it does not shrink with the step: at 1-minute steps
  // the floor is 2 failed tries a stretch, and 4 of them made a line.
  const big = episodes.filter((e) => e.count >= R.minCount[e.kind]);

  // 2. Two or more providers of one chain at the same time: the chain.
  // Compared on each burst's MAIN chain, never on everything a merged line
  // has gathered, and never into a long burst: a provider failing on eight
  // chains for days would otherwise swallow every other provider's burst on
  // any of them.
  const isLong = (e: Episode) => e.end - e.start + stepSec >= R.longSec;
  const merged: (Episode & { chainWide: boolean })[] = [];
  const used = new Set<number>();
  // Each burst here is one provider's: its kind and provider break a tie in start.
  big.sort((a, b) => a.start - b.start || cmp(a.kind, b.kind) || cmp([...a.providers][0]!, [...b.providers][0]!));
  for (let i = 0; i < big.length; i++) {
    if (used.has(i)) continue;
    const first = big[i]!;
    const e = { ...first, providers: new Set(first.providers), chains: new Map(first.chains), chainWide: false };
    if (isLong(first)) { merged.push(e); continue; }
    const firstMain = mainOf(first);
    for (let j = i + 1; j < big.length; j++) {
      const o = big[j]!;
      // Sorted by start: once one starts past this burst, so does every one after it.
      if (o.start > e.end + stepSec) break;
      if (used.has(j) || isLong(o)) continue;
      const overlap = e.start <= o.end + stepSec;
      const sameChain = mainOf(o) === firstMain;
      const otherProvider = [...o.providers].some((p) => !e.providers.has(p));
      if (overlap && sameChain && otherProvider && o.kind === e.kind) {
        used.add(j);
        o.providers.forEach((p) => e.providers.add(p));
        o.chains.forEach((v, c) => e.chains.set(c, (e.chains.get(c) ?? 0) + v));
        e.start = Math.min(e.start, o.start);
        e.end = Math.max(e.end, o.end);
        e.count += o.count;
        e.peak = Math.max(e.peak, o.peak);
        e.chainWide = true;
      }
    }
    merged.push(e);
  }

  // 3. The same cause again within a few hours: one line, with waves.
  const causeKey = (e: Episode & { chainWide: boolean }) =>
    e.chainWide ? `${e.kind}|chain|${mainOf(e)}` : `${e.kind}|${[...e.providers].sort().join(",")}|${mainOf(e)}`;
  const byCause = new Map<string, (Episode & { chainWide: boolean })[]>();
  for (const e of merged) (byCause.get(causeKey(e)) ?? byCause.set(causeKey(e), []).get(causeKey(e))!).push(e);
  const lines: ErrorIncidentLine[] = [];
  const newest = to;
  for (const [key, eps] of byCause) {
    eps.sort((a, b) => a.start - b.start);
    let group: typeof eps = [];
    const flush = () => {
      if (!group.length) return;
      const providers = new Set<string>(), chains = new Map<string, number>();
      for (const e of group) {
        e.providers.forEach((p) => providers.add(p));
        e.chains.forEach((v, c) => chains.set(c, (chains.get(c) ?? 0) + v));
      }
      const start = group[0]!.start, end = Math.max(...group.map((e) => e.end));
      const waves = group.map((e) => ({ start: e.start, end: e.end, count: Math.round(e.count) }));
      const chainWide = group.some((e) => e.chainWide);
      // A wave of 6 hours or more makes the line long-running, whatever waves came with it.
      const shape: ErrorIncidentShape = waves.some((w) => w.end - w.start + stepSec >= R.longSec) ? "long-running"
        : chainWide ? "chain-wide"
        : waves.length >= R.recurringWaves ? "recurring" : "incident";
      // A point counts the stretch before it: one at `windowFrom` is all before the window.
      if (end > windowFrom) {
        lines.push({
          key: `${key}|${start}`, kind: group[0]!.kind, shape, providers: [...providers].sort(),
          chains: [...chains].sort(byCount).map(([spec, count]) => ({ spec, count: Math.round(count) })),
          start, end, count: Math.round(group.reduce((s, e) => s + e.count, 0)), peak: Math.round(Math.max(...group.map((e) => e.peak))),
          waves, ongoing: end >= newest - stepSec,
        });
      }
      group = [];
    };
    for (const e of eps) {
      const last = group[group.length - 1];
      if (last && e.start - last.end > R.repeatSec) flush();
      group.push(e);
    }
    flush();
  }
  lines.sort((a, b) => Number(b.ongoing) - Number(a.ongoing) || b.end - a.end || b.start - a.start || cmp(a.key, b.key));
  steady.sort((a, b) => b.perMinute - a.perMinute || cmp(`${a.kind}|${a.spec}|${a.provider}`, `${b.kind}|${b.spec}|${b.provider}`));
  return { lines, steady };
}
