/* A chart's time axis, shared by the charts laid out by time: the Upstreams
   deep-dive's and the Transactions tab's. Times are unix seconds unless a
   name says ms. */
import type { ChartGrid } from "@sr/shared";
import type { XTick } from "@/components/gateway/charts";

/** Every point of a grid, unix seconds: the chart's time axis. */
export function gridTimes(grid: ChartGrid | undefined): number[] {
  if (!grid || grid.stepSec <= 0) return [];
  const out: number[] = [];
  for (let t = grid.start; t <= grid.end; t += grid.stepSec) out.push(t);
  return out;
}

export const dayOf = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
export const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

/** Tick spacings for a time axis: the clock's own, a minute to a week. */
const TICK_STEPS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 259200, 604800];

/** Labels at round local times across [from, to] (unix seconds), seven at
 *  most: 00:00 · 06:00 · 12:00 · 18:00 across a day, a date a day across a
 *  week. The evenly spaced labels this replaced landed on 00:37 and 06:45. */
export function timeTicks(dom: [number, number] | undefined): XTick[] | undefined {
  if (!dom) return undefined;
  const [from, to] = dom;
  const span = to - from;
  const step = TICK_STEPS.find((sec) => span / sec <= 7) ?? 604800;
  const tz = -new Date(to * 1000).getTimezoneOffset() * 60;
  const out: XTick[] = [];
  for (let t = Math.ceil((from + tz) / step) * step - tz; t <= to; t += step) {
    const d = new Date(t * 1000);
    const midnight = d.getHours() === 0 && d.getMinutes() === 0;
    out.push({ at: t, label: step >= 86400 || (span > 86400 && midnight) ? dayOf(t * 1000) : hhmm(t * 1000) });
  }
  return out;
}

/** "10 minutes", "an hour", "6 hours", "a day" - one bar's span. */
export const barSpanWords = (sec: number) =>
  sec >= 86400 ? (sec === 86400 ? "a day" : `${sec / 86400} days`) : sec >= 3600 ? (sec === 3600 ? "an hour" : `${sec / 3600} hours`) : `${sec / 60} minutes`;

/** A bar's stretch in words - "Oct 20, 16:10 - 16:20", "… - now" for the one
 *  still filling. `endSec` is its end, `stepSec` its span, `asOf` when it was read. */
export function barWords(endSec: number, stepSec: number, asOf: number): string {
  const from = (endSec - stepSec) * 1000;
  const to = Math.min(endSec, asOf) * 1000;
  const end = endSec > asOf ? "now" : dayOf(to) === dayOf(from) || stepSec < 86400 ? hhmm(to) : `${dayOf(to)} ${hhmm(to)}`;
  return `${dayOf(from)}, ${hhmm(from)} - ${end}`;
}
