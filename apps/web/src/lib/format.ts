/** Display formatters. Always handle null (the API returns null for unbacked
 *  values — we render "—", never a fabricated number). */

export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(n % 1 === 0 ? 0 : 1);
}

/** Comma-grouped integer (the prototype's fmtComma). */
export function fmtComma(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return Math.round(n).toLocaleString("en-US");
}

export function fmtPct(ratio: number | null | undefined, digits = 2): string {
  if (ratio === null || ratio === undefined) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  return `${Math.round(ms)} ms`;
}

export function fmtBlock(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `#${Math.round(n).toLocaleString()}`;
}

/**
 * How long ago a timestamp was, coarsely. For "when was this last read" lines,
 * where the exact second is noise and staleness is the whole point. `now` is
 * injectable so a test isn't racing the clock.
 */
export function fmtAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (iso === null || iso === undefined) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const sec = Math.max(0, (now - then) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

/**
 * A tip lag in seconds, short-form. Seconds below a minute, then m/h — a lag
 * that reaches hours is a dead upstream, not a number anyone reads precisely.
 */
export function fmtLag(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "—";
  if (sec < 1) return "0s";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}
