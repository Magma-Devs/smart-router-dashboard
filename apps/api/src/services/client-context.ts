import { isIP } from "node:net";

/**
 * Turning a raw request into the two fields a session row and an audit access
 * event carry: the caller's address, and a human-readable device string.
 *
 * Deliberately small and deliberately lossy. `client` exists so a person
 * scanning their own sessions list recognises a device, and so an investigator
 * reading `signin.failed` rows can tell "one person mistyping" from "a run of
 * attempts from somewhere else". Neither needs a full UA taxonomy. A session
 * row keeps the raw User-Agent next to it; an audit row keeps only this.
 *
 * Both inputs are headers the caller writes, and both land in columns that
 * refuse a bad value — `client` is varchar(128), `ip` is `inet`. A refused
 * value fails a session insert, and it silently loses a standalone audit row.
 * So both functions return something the column accepts, or null.
 */

/** Ordered most- to least-specific: Edge and Opera also claim "Chrome", and
 *  Chrome also claims "Safari", so the first match wins by construction. */
const BROWSERS: ReadonlyArray<[name: string, pattern: RegExp]> = [
  ["Edge", /Edg(?:e|A|iOS)?\/(\d+)/],
  ["Opera", /OPR\/(\d+)/],
  ["Samsung Internet", /SamsungBrowser\/(\d+)/],
  ["Firefox", /(?:Firefox|FxiOS)\/(\d+)/],
  ["Chrome", /(?:Chrome|CriOS)\/(\d+)/],
  ["Safari", /Version\/(\d+).*Safari/],
];

/** Matched after browsers, on the same string. */
const PLATFORMS: ReadonlyArray<[name: string, pattern: RegExp]> = [
  ["Android", /Android/],
  ["iOS", /(?:iPhone|iPad|iPod)/],
  ["macOS", /Mac OS X|Macintosh/],
  ["Windows", /Windows NT/],
  ["Linux", /Linux|X11/],
];

/** No browser has shipped a five-digit major version. A longer one is made up,
 *  and repeating it would let the header decide how long `client` is. */
const MAX_VERSION_DIGITS = 4;

/**
 * `"Chrome 141 / macOS"`, or the best partial we can manage, or null. Never
 * longer than a name, four digits and a platform, whatever the header says.
 *
 * Null is a normal outcome — a curl, a health checker, or a browser we don't
 * pattern-match. Callers render "—" rather than guessing.
 */
export function parseClient(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;

  let browser: string | null = null;
  for (const [name, pattern] of BROWSERS) {
    const match = pattern.exec(userAgent);
    if (match) {
      const version = match[1];
      browser = version && version.length <= MAX_VERSION_DIGITS ? `${name} ${version}` : name;
      break;
    }
  }

  let platform: string | null = null;
  for (const [name, pattern] of PLATFORMS) {
    if (pattern.test(userAgent)) {
      platform = name;
      break;
    }
  }

  if (browser && platform) return `${browser} / ${platform}`;
  return browser ?? platform;
}

/**
 * Normalise an address for the `inet` column, or null when it isn't one.
 * Strips IPv4-mapped IPv6 (`::ffff:10.0.0.1`), which is what a dual-stack
 * listener reports for a plain IPv4 client and reads as noise in an audit row.
 *
 * `isIP` rather than a pattern: a shape check let `:::` and nine-group
 * addresses through to an insert that refused them. `isIP` accepts one thing
 * `inet` refuses, an IPv6 zone (`fe80::1%eth0`), so that is refused here too.
 */
export function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const trimmed = ip.trim();
  if (!trimmed) return null;

  const mapped = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i.exec(trimmed);
  const candidate = mapped?.[1] ?? trimmed;

  return isIP(candidate) !== 0 && !candidate.includes("%") ? candidate : null;
}
