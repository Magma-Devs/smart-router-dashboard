/**
 * Turning a raw request into the two fields a session row and an audit access
 * event carry: the caller's address, and a human-readable device string.
 *
 * Deliberately small and deliberately lossy. `client` exists so a person
 * scanning their own sessions list recognises a device, and so an investigator
 * reading `signin.failed` rows can tell "one person mistyping" from "a run of
 * attempts from somewhere else". Neither needs a full UA taxonomy, and the raw
 * User-Agent is stored alongside it regardless — so when this returns null,
 * nothing is lost that wasn't already recorded.
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

/**
 * `"Chrome 141 / macOS"`, or the best partial we can manage, or null.
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
      browser = match[1] ? `${name} ${match[1]}` : name;
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

/** Loose IPv4 / IPv6 shapes. Postgres `inet` rejects anything malformed with an
 *  error, and a sign-in must never fail because a proxy sent a odd header — so
 *  we screen here and store null rather than letting the insert throw. */
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-fA-F:]+$/;

/**
 * Normalise an address for the `inet` column, or null when it isn't one.
 * Strips IPv4-mapped IPv6 (`::ffff:10.0.0.1`), which is what a dual-stack
 * listener reports for a plain IPv4 client and reads as noise in an audit row.
 */
export function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const trimmed = ip.trim();
  if (!trimmed) return null;

  const mapped = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i.exec(trimmed);
  const candidate = mapped?.[1] ?? trimmed;

  if (IPV4.test(candidate)) {
    return candidate.split(".").every((o) => Number(o) <= 255) ? candidate : null;
  }
  // Require a colon so a bare hostname can't pass the hex test.
  if (candidate.includes(":") && IPV6.test(candidate)) return candidate;
  return null;
}
