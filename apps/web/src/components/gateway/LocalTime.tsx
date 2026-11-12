"use client";

import { useSyncExternalStore, type CSSProperties } from "react";
import {
  fmtDate,
  fmtDateTime,
  fmtDay,
  fmtDayTime,
  fmtRelative,
  fmtTime,
  fmtTimeSec,
  isoUtc,
  timeTitle,
  zoneLabel,
  zoneName,
  type Instant,
} from "@/lib/datetime";

const FORMAT = {
  time: fmtTime,
  timeSec: fmtTimeSec,
  day: fmtDay,
  date: fmtDate,
  dayTime: fmtDayTime,
  dateTime: fmtDateTime,
  relative: fmtRelative,
} as const;

export type LocalTimeFormat = keyof typeof FORMAT;

const noSubscription = () => () => {};

/** False in the server render and in the hydration pass that has to match
 *  it, true from then on - and at once for anything mounted later. */
function useMounted(): boolean {
  return useSyncExternalStore(noSubscription, () => true, () => false);
}

/**
 * A time where the reader is (`lib/datetime.ts` has the formats), as a
 * `<time>` that carries the instant in ISO UTC and a tooltip giving it in
 * full, local and UTC.
 *
 * The server knows only its own zone, so until mount this renders the ISO
 * value and the browser's render localises it: the HTML never carries the
 * server's clock, and hydration has nothing to disagree with.
 */
export function LocalTime({ t, format, title = true, className, style }: {
  t: Instant;
  format: LocalTimeFormat;
  /** False where the surrounding element has a tooltip of its own. */
  title?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const mounted = useMounted();
  const iso = isoUtc(t);
  if (!iso) return <span className={className} style={style}>—</span>;
  return (
    <time dateTime={iso} title={title ? (mounted ? timeTitle(t) : iso) : undefined} className={className} style={style}>
      {mounted ? FORMAT[format](t) : iso}
    </time>
  );
}

/**
 * `(GMT+2)`: the reader's zone, for the header of a column of times, so
 * someone comparing them with logs knows which clock they are on. Nothing
 * in the server render.
 *
 * The offset is today's. A time from the other side of a DST change is on
 * the same clock with the offset it had then, which its own tooltip gives.
 */
export function ZoneLabel({ style }: { style?: CSSProperties }) {
  const mounted = useMounted();
  if (!mounted) return null;
  const zone = zoneLabel();
  return (
    <span
      title={`Your browser's time zone, ${zoneName()} (${zone} today). Hover a time for UTC and the offset it had then.`}
      style={style}
    >
      ({zone})
    </span>
  );
}
