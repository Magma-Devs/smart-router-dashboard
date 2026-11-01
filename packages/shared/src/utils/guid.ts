/**
 * When a request ID was minted, read off the ID itself. smart-router v1.6.1
 * and later mint a request's GUID as the unix second in its top 32 bits over
 * a per-process counter, written in decimal (utils/uniqueIdentifier.go);
 * earlier routers mint a random 64-bit number. Any GUID decodes to some
 * second, so only one that lands where the logs can be is taken as minted
 * then: from the widest window back (30 days) to a few minutes ahead, for a
 * router clock that runs fast. A random GUID lands there about 0.06% of the
 * time (30 days of seconds out of 2^32).
 */
import { WINDOWS } from "../constants/windows.js";

/** The oldest a minted second may be: the widest window the dashboard reads. */
export const GUID_MAX_AGE_SEC = WINDOWS["30d"].rangeSeconds;

/** How far ahead of now: a router clock a little ahead of ours. */
export const GUID_MAX_AHEAD_SEC = 300;

/** Decimal as the router writes it (strconv.FormatUint): no sign, no leading zero. */
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;

/** The unix second a GUID was minted in; null when it isn't a uint64 or its second is implausible. */
export function guidMintedSecond(guid: string, nowSec: number): number | null {
  if (!DECIMAL.test(guid)) return null;
  // BigInt: a GUID runs past 2^53, where a number would round.
  const value = BigInt(guid);
  if (value >> 64n !== 0n) return null;
  const sec = Number(value >> 32n);
  return sec >= nowSec - GUID_MAX_AGE_SEC && sec <= nowSec + GUID_MAX_AHEAD_SEC ? sec : null;
}
