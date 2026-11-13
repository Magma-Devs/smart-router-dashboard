/* A chart's time axis, shared by the charts laid out by time: the Upstreams
   deep-dive's and the Transactions tab's. Times are unix seconds unless a
   name says ms. */
import type { ChartGrid } from "@sr/shared";
import type { XTick } from "@/components/gateway/charts";
import { fmtDay, fmtDayTime, fmtTime } from "@/lib/datetime";

/** Every point of a grid, unix seconds: the chart's time axis. */
export function gridTimes(grid: ChartGrid | undefined): number[] {
  if (!grid || grid.stepSec <= 0) return [];
  const out: number[] = [];
  for (let t = grid.start; t <= grid.end; t += grid.stepSec) out.push(t);
  return out;
}

/** Tick spacings for a time axis: the clock's own, a minute to a week. */
const TICK_STEPS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 259200, 604800];

/** The reader's UTC offset at `t` (unix seconds), in seconds: 7200 in Tel Aviv in winter. */
const offsetAt = (t: number) => -new Date(t * 1000).getTimezoneOffset() * 60;

/** Labels at round local times across [from, to] (unix seconds), seven at
 *  most: 00:00 · 06:00 · 12:00 · 18:00 across a day, a date a day across a
 *  week. The evenly spaced labels this replaced landed on 00:37 and 06:45.
 *
 *  A round time is a multiple of the step on the reader's clock: unix time
 *  plus the offset the zone is on at that moment. A window across a DST
 *  change has two offsets, so each one's round times are kept only where the
 *  zone is on it. The ticks on either side of the change then sit on round
 *  times of their own (00:00 before it and after it), and a time the clock
 *  skips when it goes forward gets no tick. */
export function timeTicks(dom: [number, number] | undefined): XTick[] | undefined {
  if (!dom) return undefined;
  const [from, to] = dom;
  const span = to - from;
  const step = TICK_STEPS.find((sec) => span / sec <= 7) ?? 604800;
  const offsets = new Set([offsetAt(to)]);
  for (let t = from; t < to; t += step) offsets.add(offsetAt(t));
  const at: number[] = [];
  for (const tz of offsets) {
    for (let t = Math.ceil((from + tz) / step) * step - tz; t <= to; t += step) {
      if (offsetAt(t) === tz) at.push(t);
    }
  }
  return at.sort((a, b) => a - b).map((t) => {
    const d = new Date(t * 1000);
    const midnight = d.getHours() === 0 && d.getMinutes() === 0;
    return { at: t, label: step >= 86400 || (span > 86400 && midnight) ? fmtDay(t * 1000) : fmtTime(t * 1000) };
  });
}

/** "10 minutes", "an hour", "6 hours", "a day" - one bar's span. */
export const barSpanWords = (sec: number) =>
  sec >= 86400 ? (sec === 86400 ? "a day" : `${sec / 86400} days`) : sec >= 3600 ? (sec === 3600 ? "an hour" : `${sec / 3600} hours`) : `${sec / 60} minutes`;

/** A bar's stretch in words - "Oct 20, 16:10 - 16:20", "… - now" for the one
 *  still filling. `endSec` is its end, `stepSec` its span, `asOf` when it was read. */
export function barWords(endSec: number, stepSec: number, asOf: number): string {
  const from = (endSec - stepSec) * 1000;
  const to = Math.min(endSec, asOf) * 1000;
  const end = endSec > asOf ? "now" : fmtDay(to) === fmtDay(from) || stepSec < 86400 ? fmtTime(to) : fmtDayTime(to);
  return `${fmtDayTime(from)} - ${end}`;
}
