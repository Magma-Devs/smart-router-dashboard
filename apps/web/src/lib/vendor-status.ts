import type { VendorStatus } from "@sr/shared";

/**
 * ONE vocabulary for what an upstream VENDOR says about itself, the way
 * `lib/health.ts` owns the vocabulary for what this deployment measures. The
 * two must not be confused on screen: health is ours (Prometheus), vendor
 * status is theirs (their own status page, read by the Status Page Index).
 *
 * SPI's words, straight from its parsers:
 *
 *  - `official`: `operational` · `maintenance` · `minor` · `major` ·
 *    `critical` · `unknown` (feed exists, not readable right now) ·
 *    `unavailable` (**the vendor publishes no machine-readable feed at all**).
 *  - `measured`: `up` · `degraded` · `down` · `unconfigured` (SPI probes
 *    nothing for them) · `paused` · `unknown`.
 *
 * The two "no data" words are the trap. `unavailable` and `unconfigured` read
 * like outages and are the opposite: they mean nobody is reporting. They map
 * to `unknown` — grey, never red — for the same reason `HealthState.unknown`
 * does: "no reading" is not "down".
 */
export type VendorSeverity = "operational" | "degraded" | "outage" | "unknown";

const OFFICIAL_SEVERITY: Record<string, VendorSeverity> = {
  operational: "operational",
  maintenance: "degraded",
  minor: "degraded",
  major: "outage",
  critical: "outage",
  unknown: "unknown",
  unavailable: "unknown",
};

const MEASURED_SEVERITY: Record<string, VendorSeverity> = {
  up: "operational",
  operational: "operational",
  degraded: "degraded",
  down: "outage",
  unconfigured: "unknown",
  paused: "unknown",
  unknown: "unknown",
};

/** A word SPI grows later is `unknown` here — never guessed into a colour. */
export function officialSeverity(status: string | null | undefined): VendorSeverity {
  if (!status) return "unknown";
  return OFFICIAL_SEVERITY[status] ?? "unknown";
}

export function measuredSeverity(status: string | null | undefined): VendorSeverity {
  if (!status) return "unknown";
  return MEASURED_SEVERITY[status] ?? "unknown";
}

const SEVERITY_RANK: Record<VendorSeverity, number> = {
  outage: 0,
  degraded: 1,
  operational: 2,
  unknown: 3,
};

/** The worse of what they publish and what SPI measures — one chip, one colour. */
export function vendorSeverity(vendor: VendorStatus): VendorSeverity {
  const official = officialSeverity(vendor.official.status);
  const measured = measuredSeverity(vendor.measuredStatus);
  return SEVERITY_RANK[official] <= SEVERITY_RANK[measured] ? official : measured;
}

/**
 * Whether this vendor is reporting a problem RIGHT NOW — the banner's trigger.
 *
 * Only `degraded` / `outage` count. "Their page can't be read" and "SPI probes
 * nothing here" are the normal state of half the catalog; bannering on them
 * would put a permanent warning on the dashboard that says nothing, which is
 * the fastest way to teach an operator to ignore the banner that matters.
 */
export function vendorHasIncident(vendor: VendorStatus): boolean {
  const severity = vendorSeverity(vendor);
  return severity === "degraded" || severity === "outage";
}

export const VENDOR_SEVERITY_COLOR: Record<VendorSeverity, string> = {
  operational: "var(--ok)",
  degraded: "var(--warn)",
  outage: "var(--err)",
  unknown: "var(--text-4)",
};

/** `gw-tag` variant for a chip carrying a vendor severity. */
export function vendorTagClass(severity: VendorSeverity): string {
  if (severity === "operational") return "gw-tag gw-tag--ok";
  if (severity === "degraded") return "gw-tag gw-tag--warn";
  if (severity === "outage") return "gw-tag gw-tag--err";
  return "gw-tag";
}

const OFFICIAL_LABEL: Record<string, string> = {
  operational: "Operational",
  maintenance: "Maintenance",
  minor: "Minor issues",
  major: "Major issues",
  critical: "Critical outage",
  unknown: "Status unknown",
  unavailable: "No status feed",
};

const MEASURED_LABEL: Record<string, string> = {
  up: "Up",
  operational: "Up",
  degraded: "Degraded",
  down: "Down",
  unconfigured: "Not probed",
  paused: "Probes paused",
  unknown: "Unknown",
};

/** Their word, in ours. An unmapped word is shown as SPI sent it — capitalised
 *  but never renamed, because inventing a synonym for a state we don't know is
 *  how a dashboard starts lying. */
function label(map: Record<string, string>, status: string | null | undefined): string {
  if (!status) return "Unknown";
  return map[status] ?? status.charAt(0).toUpperCase() + status.slice(1);
}

export function officialStatusLabel(status: string | null | undefined): string {
  return label(OFFICIAL_LABEL, status);
}

export function measuredStatusLabel(status: string | null | undefined): string {
  return label(MEASURED_LABEL, status);
}

/** Why a vendor chip reads grey — the tooltip's one-liner. */
export function vendorUnknownHint(status: string | null | undefined): string | null {
  if (status === "unavailable") return "This vendor publishes no machine-readable status feed.";
  if (status === "unknown") return "The status index could not read their status page.";
  return null;
}

/**
 * The vendors present in THIS topology that are reporting a problem, worst
 * first. `presentSlugs` are the catalog ids the mounted config actually
 * matched — a vendor nobody here routes through is somebody else's outage.
 */
export function affectedVendors(
  vendors: VendorStatus[] | null,
  presentSlugs: Set<string>,
): VendorStatus[] {
  if (vendors === null) return [];
  return vendors
    .filter((v) => presentSlugs.has(v.slug) && vendorHasIncident(v))
    .sort((a, b) => SEVERITY_RANK[vendorSeverity(a)] - SEVERITY_RANK[vendorSeverity(b)]);
}

/** Dismissal identity: the same vendor in a WORSE state is a new banner. */
export function vendorBannerKey(vendor: VendorStatus): string {
  return `${vendor.slug}:${vendor.official.status}:${vendor.measuredStatus ?? "none"}`;
}
