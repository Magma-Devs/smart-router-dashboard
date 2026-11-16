/**
 * The words for the Overview's reliability cards: how many requests got an
 * answer, and how long the router kept a chain answering while a provider
 * was failing. Pure, so the numbers a customer reads are pinned by tests.
 */
import { fmtComma, fmtNum } from "./format";

/**
 * The share of client requests that got an answer, written with as many
 * decimals as it takes NOT to read 100% while any failed: a rate rounded to
 * two decimals shows "100.00%" for 2,397 failures in 215 million, and a
 * change of a few thousand failures doesn't move it. Under it, what it is a
 * share of; the failures have a card of their own. Null with no requests at
 * all.
 */
export function answeredWords(served: number, failed: number): { value: string; sub: string } | null {
  const total = served + failed;
  if (!(total > 0)) return null;
  const sub = `of ${fmtNum(total)} requests`;
  if (failed <= 0) return { value: "100%", sub };
  // Enough decimals for two digits of the failed share (0.0011% failed is
  // 99.9989%), five at most; a share that still rounds up to 100 says so.
  const failedPct = (failed / total) * 100;
  const decimals = Math.min(5, Math.max(2, Math.ceil(-Math.log10(failedPct)) + 1));
  const s = ((served / total) * 100).toFixed(decimals);
  return { value: Number(s) < 100 ? `${s}%` : "under 100%", sub };
}

/** A length of time for a card's headline: "0 min", "12 min", "2 h 10 min", "19 h 40 min", "3 days 4 h". */
export function spanWords(sec: number): string {
  const m = Math.round(Math.max(0, sec) / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} days ${h % 24} h` : `${d} days`;
}

/** "38 incidents on 11 chains", singular where it is one. */
export function incidentsWords(incidents: number, chains: number): string {
  return `${fmtComma(incidents)} ${incidents === 1 ? "incident" : "incidents"} on ${fmtComma(chains)} ${chains === 1 ? "chain" : "chains"}`;
}
