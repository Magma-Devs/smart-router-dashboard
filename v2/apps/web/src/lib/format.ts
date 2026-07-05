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
