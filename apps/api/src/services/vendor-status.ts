/**
 * Upstream VENDOR status, read from the Status Page Index (SPI).
 *
 * The dashboard measures what the router sees; it cannot see whether Alchemy
 * or dRPC has declared an incident on their own status page. SPI does exactly
 * that — it polls every vendor's page and normalizes the verdict — so one
 * server-side read answers the question every upstream outage raises first:
 * "is this deployment broken, or is it the vendor?".
 *
 * Two rules shape this service:
 *
 *  - **The api reads SPI, never the browser.** SPI is keyless but rate-limited
 *    per IP (30/min); a dashboard open in a dozen tabs would burn that in
 *    seconds. One cached read per minute serves every browser, and the cache
 *    holds FAILURES too, so an SPI outage costs one attempt a minute rather
 *    than one per request.
 *  - **A read that fails yields `null`, never a guess.** No vendors means no
 *    chip and no banner — the same honesty contract the metric routes follow.
 */

import type { VendorStatus, VendorStatusReport } from "@sr/shared";

/** The keyless list route. The per-slug detail route carries a `components[]`
 *  the size of a page — this surface never needs it. */
const PROVIDER_STATUS_PATH = "/v1/public/provider-status";

export interface VendorStatusOptions {
  /** SPI base url — `STATUS_PAGE_INDEX_URL`. */
  baseUrl: string;
  /** Deadline on the api→SPI call. */
  timeoutMs: number;
  /** How long one read serves every caller. */
  ttlMs: number;
  /** Called with a one-line reason each time a read fails (logging hook). */
  onError?: (reason: string) => void;
}

export function providerStatusUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${PROVIDER_STATUS_PATH}`;
}

/** Trimmed string, or null for anything that isn't usable text. */
function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** SPI's status words are lowercase; normalize so a casing change upstream
 *  can't make `Operational` read as an unrecognised state. */
function statusWord(value: string | null): string | null {
  return value === null ? null : value.toLowerCase();
}

/**
 * One SPI row → one wire row. Camel-cased, and deliberately narrowed: the
 * vendor's `components[]` / `incidents[]` / `events[]` are never forwarded
 * (they are the bulk of the payload and nothing here renders them).
 *
 * SPI serves the official block in TWO shapes — the list route flattens it
 * into `official_*` keys, the per-slug detail route nests it under `official`
 * — so both are read. A row with no slug is dropped: the slug is what a
 * catalog id joins on, and a row nothing can match is noise.
 */
export function normalizeVendor(entry: unknown): VendorStatus | null {
  const rec = record(entry);
  if (rec === null) return null;
  const slug = str(rec.slug);
  if (slug === null) return null;

  const official = record(rec.official);
  const measured = record(rec.measured);

  return {
    slug,
    name: str(rec.name) ?? slug,
    statusPage: str(rec.status_page),
    website: str(rec.website),
    paused: rec.paused === true,
    official: {
      // "unknown" is SPI's own word for "the page could not be read", which is
      // also the honest answer when a build omits the field entirely.
      status: statusWord(str(rec.official_status) ?? str(official?.status)) ?? "unknown",
      description: str(rec.official_description) ?? str(official?.description),
      fetchedAt: str(rec.official_fetched_at) ?? str(official?.fetched_at),
    },
    measuredStatus: statusWord(str(rec.measured_status) ?? str(measured?.status)),
    officialLastChangeAt: str(rec.official_last_change_at) ?? str(official?.last_change_at),
    measuredLastChangeAt: str(rec.measured_last_change_at) ?? str(measured?.last_change_at),
  };
}

/**
 * The whole payload. Null — not `[]` — when SPI answered something that isn't
 * a list of providers: an empty list means "SPI knows no vendors", a null
 * means "we have no idea", and the UI treats those differently.
 */
export function normalizeVendors(payload: unknown): VendorStatus[] | null {
  if (!Array.isArray(payload)) return null;
  const vendors: VendorStatus[] = [];
  for (const entry of payload) {
    const vendor = normalizeVendor(entry);
    if (vendor !== null) vendors.push(vendor);
  }
  return vendors;
}

/** A cause phrase safe to log — never a stack. */
function describeCause(e: unknown): string {
  const cause = (e as { cause?: { code?: string } } | undefined)?.cause;
  if (cause?.code) return cause.code;
  if (e instanceof Error) return e.name === "TimeoutError" ? "timed out" : e.message || e.name;
  return "unknown error";
}

/**
 * One instance per api process (the route creates it), so the cache is
 * per-app — a test that builds its own app gets its own empty cache.
 */
export class VendorStatusService {
  private cached: VendorStatusReport | null = null;
  private cachedAtMs = 0;
  /** The read in progress, shared by everyone who arrives during it. */
  private inFlight: Promise<VendorStatusReport> | null = null;

  constructor(private readonly opts: VendorStatusOptions) {}

  async read(): Promise<VendorStatusReport> {
    if (this.cached !== null && Date.now() - this.cachedAtMs < this.opts.ttlMs) {
      return this.cached;
    }
    // Single-flight: a dozen browsers landing in the same second spend ONE of
    // SPI's 30 requests a minute, not a dozen.
    this.inFlight ??= this.refresh().finally(() => {
      this.inFlight = null;
    });
    return await this.inFlight;
  }

  private async refresh(): Promise<VendorStatusReport> {
    const vendors = await this.fetchVendors();
    const report: VendorStatusReport = { vendors, fetchedAt: new Date().toISOString() };
    this.cached = report;
    this.cachedAtMs = Date.now();
    return report;
  }

  private async fetchVendors(): Promise<VendorStatus[] | null> {
    try {
      const res = await fetch(providerStatusUrl(this.opts.baseUrl), {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      if (!res.ok) {
        this.opts.onError?.(`status page index answered ${res.status}`);
        return null;
      }
      // Throws on a body that isn't JSON — an html error page from a proxy in
      // front of SPI is the common case, and it must read as "no data".
      const vendors = normalizeVendors(await res.json());
      if (vendors === null) {
        this.opts.onError?.("status page index answered something that is not a provider list");
      }
      return vendors;
    } catch (e) {
      this.opts.onError?.(describeCause(e));
      return null;
    }
  }
}
