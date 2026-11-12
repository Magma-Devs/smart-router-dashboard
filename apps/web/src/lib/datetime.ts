/**
 * Every date and time the dashboard shows: one format, in the reader's own
 * time zone.
 *
 * The zone is the browser's. No formatter here names a `timeZone`, so
 * `Intl.DateTimeFormat` uses the one the reader's machine is set to, and a
 * reader in Tel Aviv and one in New York each see their own wall clock. The
 * format is the same on every screen: English month names and a 24-hour
 * clock (`hourCycle: "h23"`, so midnight reads 00:00, never 24:00).
 *
 *   fmtTime       14:22                         chart axes, the ends of a range
 *   fmtTimeSec    14:22:07                      a list row's time
 *   fmtDay        Nov 12                        chart axes, a list row's date
 *   fmtDate       Nov 12, 2026                  a date on its own: joined, expires
 *   fmtDayTime    Nov 12, 14:22                 chart tooltips, a range's start
 *   fmtDateTime   Nov 12, 2026, 14:22:07 GMT+2  one instant in full, with its zone
 *   fmtRelative   3 min ago                     "is this person still around"
 *   zoneLabel     GMT+2                         beside a column of times
 *   zoneName      Asia/Jerusalem                its tooltip
 *   isoUtc        2026-11-12T12:22:07.000Z      the instant itself: `<time dateTime>`
 *   timeTitle     both of the last two          the tooltip on a shown time
 *
 * `fmtDay` and `fmtDayTime` leave the year out: they label charts and the
 * request lists, which reach back 30 days at most.
 *
 * Data is not display. The CSV exports and the API write ISO 8601 UTC, for
 * the tools that parse them, and nothing here touches them.
 *
 * These format where they run. A server render would bake the server's zone
 * into the HTML, so a time that can be rendered on the server goes through
 * `<LocalTime>` (`components/gateway/LocalTime.tsx`), which renders the ISO
 * value there and the local one once mounted.
 */

/** An instant: unix ms, an ISO 8601 string, or a Date. */
export type Instant = number | string | Date;

/** Unix ms, or NaN when the input is not a time. */
export function toMs(t: Instant): number {
  if (typeof t === "number") return t;
  if (typeof t === "string") return Date.parse(t);
  return t.getTime();
}

const CLOCK = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;

const FORMATS = {
  time: CLOCK,
  timeSec: { ...CLOCK, second: "2-digit" },
  day: { month: "short", day: "numeric" },
  date: { month: "short", day: "numeric", year: "numeric" },
  dayTime: { month: "short", day: "numeric", ...CLOCK },
  dateTime: { month: "short", day: "numeric", year: "numeric", ...CLOCK, second: "2-digit", timeZoneName: "shortOffset" },
  zone: { timeZoneName: "shortOffset" },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

type FormatName = keyof typeof FORMATS;

/* Built once each. A list formats hundreds of rows, and building a formatter
   costs far more than using one. A formatter reads the zone when it is built,
   which is once per page load: the reader's zone, for the whole visit. */
const built = new Map<FormatName, Intl.DateTimeFormat>();
function formatter(name: FormatName): Intl.DateTimeFormat {
  let f = built.get(name);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", FORMATS[name]);
    built.set(name, f);
  }
  return f;
}

/** An em dash for a value that is not a time, as for every unbacked value. */
function format(name: FormatName, t: Instant): string {
  const ms = toMs(t);
  return Number.isFinite(ms) ? formatter(name).format(ms) : "—";
}

/** `14:22` */
export const fmtTime = (t: Instant) => format("time", t);
/** `14:22:07` */
export const fmtTimeSec = (t: Instant) => format("timeSec", t);
/** `Nov 12` */
export const fmtDay = (t: Instant) => format("day", t);
/** `Nov 12, 2026` */
export const fmtDate = (t: Instant) => format("date", t);
/** `Nov 12, 14:22` */
export const fmtDayTime = (t: Instant) => format("dayTime", t);
/** `Nov 12, 2026, 14:22:07 GMT+2` - the zone it was in then, which a DST change can make differ from today's. */
export const fmtDateTime = (t: Instant) => format("dateTime", t);

/** `GMT+2`, `GMT-5`, `GMT+5:30`, `GMT`: the reader's offset at `t` (now by default). */
export function zoneLabel(t: Instant = Date.now()): string {
  const ms = toMs(t);
  if (!Number.isFinite(ms)) return "";
  return formatter("zone").formatToParts(ms).find((p) => p.type === "timeZoneName")?.value ?? "";
}

/** `Asia/Jerusalem`: the reader's zone by name, the one every format here uses. */
export function zoneName(): string {
  return formatter("zone").resolvedOptions().timeZone;
}

/** `2026-11-12T12:22:07.000Z`, or an empty string for a value that is not a time. */
export function isoUtc(t: Instant): string {
  const ms = toMs(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

/** The tooltip on a shown time: the instant in full where the reader is, and in UTC for comparing with logs. */
export function timeTitle(t: Instant): string {
  const iso = isoUtc(t);
  return iso ? `${fmtDateTime(t)}\n${iso} (UTC)` : "";
}

/** "3 min ago", "2 hours ago", "5 days ago"; past 30 days the date. An em dash
 *  for no time at all (someone who has never signed in). A time ahead of `now`
 *  - a clock a little off - reads "just now". */
export function fmtRelative(t: Instant | null | undefined, now: number = Date.now()): string {
  if (t == null) return "—";
  const ms = toMs(t);
  if (!Number.isFinite(ms)) return "—";
  const mins = Math.floor((now - ms) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return fmtDate(ms);
}

/** Text with the ISO 8601 UTC instants in it split out, so each can be shown
 *  on the reader's clock: the instants are at the odd indices. An audit note
 *  carries one where the API wrote it (an invitation's expiry). */
export function splitInstants(text: string): string[] {
  return text.split(/(\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z\b)/);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `2026-11-12T14:22`: what `<input type="datetime-local">` holds - the
 *  reader's wall clock, to the minute. */
export function toLocalInputValue(t: Instant): string {
  const d = new Date(toMs(t));
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** The first and last millisecond of a calendar day (`yyyy-mm-dd`, what
 *  `<input type="date">` holds) where the reader is, as ISO UTC for the API.
 *  A day a DST change shortens or lengthens is 23 or 25 hours, as it is on
 *  the reader's clock. */
export function localDayStartIso(day: string): string {
  return isoUtc(new Date(`${day}T00:00:00`));
}
export function localDayEndIso(day: string): string {
  return isoUtc(new Date(`${day}T23:59:59.999`));
}
