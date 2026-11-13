/**
 * How an email states a time: `Nov 11, 2026, 14:05 UTC`.
 *
 * The dashboard's own date and clock (`apps/web/src/lib/datetime.ts`: English
 * month, day, year, 24-hour clock), with the zone written out. The dashboard
 * shows a time in the reader's zone, which its browser reports; an email has no
 * browser to ask, and an account stores no zone, so an email gives UTC and says
 * so. That is also the zone of the audit log and the CSV exports, so the time
 * in a notice can be matched against them.
 *
 * Every time an email prints goes through here, so they all read alike. Built
 * by hand rather than with `Intl`, whose wording moves with the ICU version the
 * runtime ships.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `Nov 11, 2026, 14:05 UTC`, or an em dash for a Date that is not a time. */
export function emailTime(at: Date): string {
  if (!Number.isFinite(at.getTime())) return "—";
  return (
    `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}, ${at.getUTCFullYear()}, ` +
    `${pad2(at.getUTCHours())}:${pad2(at.getUTCMinutes())} UTC`
  );
}
