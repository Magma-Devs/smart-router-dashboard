import type { VendorChainStatus, VendorStatus } from "@sr/shared";

/**
 * ONE vocabulary for what an upstream VENDOR says about a chain we route
 * through them, the way `lib/health.ts` owns the vocabulary for what this
 * deployment measures. The two must not be confused on screen: health is ours
 * (Prometheus), vendor status is theirs (their status page, read by the
 * Status Page Index).
 *
 * Everything here reads a CHAIN verdict (`vendor.chains[spec]`), never the
 * vendor's global headline. QuickNode goes "minor" whenever any of ~500
 * components dips — usually a chain nobody here touches — so the headline is
 * noise on a card about one Ethereum endpoint. It survives as tooltip context
 * and nothing else.
 *
 * The index's words, straight from its parsers:
 *
 *  - components / chains: `operational` · `maintenance` · `minor` · `major` ·
 *    `critical` · `unknown` (nothing on their page maps to this chain) ·
 *    `unavailable` (**the vendor publishes no machine-readable feed at all**).
 *  - their measured probes: `up` · `degraded` · `down` · `unconfigured` (the
 *    index probes nothing for them) · `paused`.
 *
 * The two "no data" words are the trap. `unavailable` and `unconfigured` read
 * like outages and are the opposite: they mean nobody is reporting. They map
 * to `unknown` — grey, never red — for the same reason `HealthState.unknown`
 * does: "no reading" is not "down".
 */
export type VendorSeverity = "operational" | "degraded" | "outage" | "maintenance" | "unknown";

const STATUS_SEVERITY: Record<string, VendorSeverity> = {
  operational: "operational",
  up: "operational",
  // Planned work is its own state: worth showing, never an incident.
  maintenance: "maintenance",
  minor: "degraded",
  degraded: "degraded",
  major: "outage",
  critical: "outage",
  down: "outage",
  unknown: "unknown",
  unavailable: "unknown",
  unconfigured: "unknown",
  paused: "unknown",
};

/** A word the index grows later reads as `unknown` — never guessed into a
 *  colour. `hasOwn`, so a status literally called "constructor" resolves to
 *  unknown instead of pulling a function out of the prototype chain and
 *  taking the page down with it. */
export function vendorSeverity(status: string | null | undefined): VendorSeverity {
  if (!status) return "unknown";
  return Object.hasOwn(STATUS_SEVERITY, status) ? (STATUS_SEVERITY[status] ?? "unknown") : "unknown";
}

/**
 * Worst-first — and `unknown` deliberately outranks `operational`.
 *
 * A card serving two chains through one vendor, one judged green and one with
 * no verdict at all, must not read solid green: that is the card claiming
 * knowledge it doesn't have. Ranking the unjudged chain higher turns the chip
 * grey and sends the reader to the tooltip, which lists both with reasons.
 */
const SEVERITY_RANK: Record<VendorSeverity, number> = {
  outage: 0,
  degraded: 1,
  maintenance: 2,
  unknown: 3,
  operational: 4,
};

export const VENDOR_SEVERITY_COLOR: Record<VendorSeverity, string> = {
  operational: "var(--ok)",
  degraded: "var(--warn)",
  outage: "var(--err)",
  maintenance: "var(--info)",
  unknown: "var(--text-4)",
};

/** `gw-tag` variant for a chip carrying a vendor severity. */
export function vendorTagClass(severity: VendorSeverity): string {
  if (severity === "operational") return "gw-tag gw-tag--ok";
  if (severity === "degraded") return "gw-tag gw-tag--warn";
  if (severity === "outage") return "gw-tag gw-tag--err";
  if (severity === "maintenance") return "gw-tag gw-tag--info";
  return "gw-tag";
}

const STATUS_LABEL: Record<string, string> = {
  operational: "Operational",
  up: "Operational",
  maintenance: "Maintenance",
  minor: "Minor issues",
  degraded: "Degraded",
  major: "Major issues",
  critical: "Critical outage",
  down: "Down",
  unknown: "Status unknown",
  unavailable: "No status feed",
  unconfigured: "Not probed",
  paused: "Probes paused",
};

/**
 * Their word, in ours — and the ONLY source of a chip's text, so the words and
 * the colour can never disagree (they did once: a red chip reading
 * "Operational", because the colour came from the worst of two observers and
 * the text from one of them).
 */
export function vendorStatusLabel(status: string | null | undefined): string {
  if (!status) return "Status unknown";
  if (Object.hasOwn(STATUS_LABEL, status)) return STATUS_LABEL[status] ?? status;
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/* ── Chain verdicts — what a card and the banner actually read ──────────── */

/** One chain's verdict, carrying the vendor it belongs to. */
export interface VendorChainVerdict {
  vendor: VendorStatus;
  spec: string;
  verdict: VendorChainStatus;
  severity: VendorSeverity;
}

/** The verdict for one chain, or null when the api reported none — a vendor
 *  this deployment doesn't route on that chain. */
export function chainVerdictFor(vendor: VendorStatus, spec: string): VendorChainStatus | null {
  return Object.hasOwn(vendor.chains, spec) ? (vendor.chains[spec] ?? null) : null;
}

function verdictOf(vendor: VendorStatus, spec: string, verdict: VendorChainStatus): VendorChainVerdict {
  return { vendor, spec, verdict, severity: vendorSeverity(verdict.status) };
}

/** Every chain verdict this vendor carries, worst first. */
export function vendorChainVerdicts(vendor: VendorStatus): VendorChainVerdict[] {
  return Object.entries(vendor.chains)
    .map(([spec, verdict]) => verdictOf(vendor, spec, verdict))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/**
 * The verdict a card shows: the worst among the chains that card serves.
 * Null when the api has no verdict for any of them — the card then shows no
 * chip at all rather than a reassuring grey one.
 */
export function worstChainVerdict(vendor: VendorStatus, specs: string[]): VendorChainVerdict | null {
  const verdicts = specs
    .map((spec) => {
      const verdict = chainVerdictFor(vendor, spec);
      return verdict === null ? null : verdictOf(vendor, spec, verdict);
    })
    .filter((v): v is VendorChainVerdict => v !== null);
  if (verdicts.length === 0) return null;
  return verdicts.reduce((a, b) => (SEVERITY_RANK[a.severity] <= SEVERITY_RANK[b.severity] ? a : b));
}

/**
 * Whether a chain verdict is a problem worth announcing.
 *
 * Only `degraded` / `outage` count. "Nothing on their page maps to this
 * chain", "they publish no feed" and planned maintenance are the normal state
 * of much of the roster; bannering on them would put a permanent warning on
 * the dashboard that says nothing, which is the fastest way to teach an
 * operator to ignore the banner that matters.
 */
export function isChainIncident(severity: VendorSeverity): boolean {
  return severity === "degraded" || severity === "outage";
}

/**
 * Every (vendor, chain) this deployment routes that is reporting a problem,
 * worst first. The api already scoped `chains` to the mounted topology, so
 * there is nothing to filter here — a chain in this list is a chain we route.
 */
export function affectedVendorChains(vendors: VendorStatus[] | null): VendorChainVerdict[] {
  if (vendors === null) return [];
  return vendors
    .flatMap(vendorChainVerdicts)
    .filter((v) => isChainIncident(v.severity))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/** Dismissal identity: the same vendor and chain in a WORSE state is a new
 *  banner, so waving one away can't hide the situation deteriorating. */
export function vendorChainKey(slug: string, spec: string, status: string): string {
  return `${slug}:${spec}:${status}`;
}

/**
 * Drop dismissals for a (vendor, chain) that is no longer reporting anything.
 *
 * Without this, a chain that recovers and then breaks the same way stays
 * hidden for the rest of the session — and the second incident is exactly as
 * newsworthy as the first.
 */
export function pruneDismissals(dismissed: string[], vendors: VendorStatus[] | null): string[] {
  if (vendors === null || dismissed.length === 0) return dismissed;
  const stillReporting = new Set(
    affectedVendorChains(vendors).map((v) => `${v.vendor.slug}:${v.spec}`),
  );
  const kept = dismissed.filter((key) => {
    const [slug, spec] = key.split(":");
    return stillReporting.has(`${slug}:${spec}`);
  });
  return kept.length === dismissed.length ? dismissed : kept;
}
