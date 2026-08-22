/**
 * Upstream VENDOR status, read from the Status Page Index (SPI).
 *
 * The dashboard measures what the router sees; it cannot see whether Alchemy
 * or dRPC has declared an incident on their own status page. SPI does exactly
 * that — it polls every vendor's page and normalizes the verdict — so one
 * server-side read answers the question every upstream outage raises first:
 * "is this deployment broken, or is it the vendor?".
 *
 * Four rules shape this service:
 *
 *  - **The api reads SPI, never the browser.** SPI is keyless but rate-limited
 *    per IP (30/min); a dashboard open in a dozen tabs would burn that in
 *    seconds. One cached read per minute serves every browser.
 *  - **The verdict is per chain, not per vendor.** The list route carries no
 *    components, so every vendor this deployment actually routes through gets
 *    a detail read (`/v1/public/provider-status/{slug}`), cached per slug. The
 *    present vendors are the handful named in the mounted values file — two to
 *    five in practice, far inside the rate limit — and `vendor-components.ts`
 *    turns their components into a per-chain verdict.
 *  - **A blip never erases what we know.** A failed read keeps the last good
 *    answer and flags it `stale`; only a short backoff separates retries. The
 *    alternative — blanking the data for a full minute — does it precisely
 *    during the incident this feature exists to explain. An expired-but-good
 *    answer is served immediately while the refresh runs behind it, so nobody
 *    waits on someone else's slow status page.
 *  - **Nothing is invented.** No good read ever ⇒ `vendors: null`. Switched
 *    off (`STATUS_PAGE_INDEX_URL=""`) ⇒ `disabled: true` and no outbound call.
 */

import type {
  VendorChainComponent,
  VendorChainStatus,
  VendorStatus,
  VendorStatusReport,
} from "@sr/shared";
import { chainVerdict, type VendorChainUse } from "./vendor-components.js";

/** The keyless list route; `${…}/{slug}` is the detail one. */
const PROVIDER_STATUS_PATH = "/v1/public/provider-status";

export interface VendorStatusOptions {
  /** SPI base url — `STATUS_PAGE_INDEX_URL`. Empty string = feature off. */
  baseUrl: string;
  /** Deadline on the api→SPI call. */
  timeoutMs: number;
  /** How long one good read serves every caller. */
  ttlMs: number;
  /** How long a failed read is left alone before the next attempt. */
  failureTtlMs: number;
  /** Called with a one-line reason each time a read fails (logging hook). */
  onError?: (reason: string) => void;
}

export function providerStatusUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${PROVIDER_STATUS_PATH}`;
}

/** The detail route for one vendor — the only place components live. */
export function providerDetailUrl(baseUrl: string, slug: string): string {
  return `${providerStatusUrl(baseUrl)}/${encodeURIComponent(slug)}`;
}

/** Trimmed string, or null for anything that isn't usable text. */
function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A string safe to put in an `href`. The index is a trusted service, but these
 * two fields are typed by whoever registered the vendor and land in the
 * browser as links — `javascript:` and `data:` are not links.
 */
function httpUrl(value: unknown): string | null {
  const raw = str(value);
  if (raw === null) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
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
 * One SPI row → one wire row, minus the chains (filled in by `read`).
 * Camel-cased, and deliberately narrowed: a vendor's `incidents[]` /
 * `events[]` are never forwarded, and `components[]` reaches the wire only as
 * the handful that matched a chain we route.
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
    statusPage: httpUrl(rec.status_page),
    website: httpUrl(rec.website),
    paused: rec.paused === true,
    chains: {},
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
 * The whole list payload. Null — not `[]` — when SPI answered something that
 * isn't a list of providers: an empty list means "SPI knows no vendors", a
 * null means "we have no idea", and the UI treats those differently.
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

/** What the detail route is read for: the page's components, plus the headline
 *  word that tells "no feed" apart from "feed says fine". */
export interface VendorDetail {
  officialStatus: string;
  components: VendorChainComponent[];
}

export function normalizeVendorDetail(payload: unknown): VendorDetail | null {
  const rec = record(payload);
  if (rec === null) return null;
  const official = record(rec.official);
  const raw = official?.components;
  const components: VendorChainComponent[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const comp = record(entry);
    const name = str(comp?.name);
    if (name === null) continue;
    components.push({ name, status: statusWord(str(comp?.status)) ?? "unknown" });
  }
  return {
    officialStatus: statusWord(str(rec.official_status) ?? str(official?.status)) ?? "unknown",
    components,
  };
}

/** A cause phrase safe to log — never a stack. */
function describeCause(e: unknown): string {
  const cause = (e as { cause?: { code?: string } } | undefined)?.cause;
  if (cause?.code) return cause.code;
  if (e instanceof Error) return e.name === "TimeoutError" ? "timed out" : e.message || e.name;
  return "unknown error";
}

/** What a cached slot hands back: the value, when it was read, and whether
 *  the latest attempt to refresh it failed. */
interface CachedValue<T> {
  value: T | null;
  fetchedAt: string | null;
  stale: boolean;
}

/**
 * One cached resource: last GOOD value, single-flight refresh, short backoff
 * after a failure, and stale-while-revalidate on expiry.
 *
 * A failed load NEVER replaces a good value — that is the whole point. It only
 * marks it stale and schedules the next attempt `failureTtlMs` later.
 */
class Cached<T> {
  private value: T | null = null;
  private fetchedAtMs = 0;
  private fetchedAtIso: string | null = null;
  private lastAttemptMs = 0;
  private lastAttemptFailed = false;
  private inFlight: Promise<void> | null = null;

  async read(
    opts: { ttlMs: number; failureTtlMs: number },
    load: () => Promise<T | null>,
  ): Promise<CachedValue<T>> {
    const now = Date.now();
    const hasValue = this.value !== null;
    const fresh = hasValue && now - this.fetchedAtMs < opts.ttlMs;
    const backingOff = this.lastAttemptFailed && now - this.lastAttemptMs < opts.failureTtlMs;

    if (!fresh && !backingOff) {
      const refresh = this.refresh(load);
      // Nothing good to serve yet ⇒ the caller waits. Otherwise the stale
      // value goes out now and the refresh lands for the next reader.
      if (!hasValue) await refresh;
    }
    return {
      value: this.value,
      fetchedAt: this.fetchedAtIso,
      stale: this.value !== null && (this.lastAttemptFailed || Date.now() - this.fetchedAtMs >= opts.ttlMs),
    };
  }

  private refresh(load: () => Promise<T | null>): Promise<void> {
    this.inFlight ??= load()
      .then((loaded) => {
        this.lastAttemptMs = Date.now();
        this.lastAttemptFailed = loaded === null;
        if (loaded !== null) {
          this.value = loaded;
          this.fetchedAtMs = this.lastAttemptMs;
          this.fetchedAtIso = new Date(this.lastAttemptMs).toISOString();
        }
      })
      .catch(() => {
        // A loader is not supposed to throw; if one does, treat it as a failed
        // attempt rather than losing the good value to an unhandled rejection.
        this.lastAttemptMs = Date.now();
        this.lastAttemptFailed = true;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}

/**
 * One instance per api process (the route creates it), so the caches are
 * per-app — a test that builds its own app starts cold.
 */
export class VendorStatusService {
  private readonly list = new Cached<VendorStatus[]>();
  /** Per vendor slug: the detail read that carries their components. */
  private readonly details = new Map<string, Cached<VendorDetail>>();

  constructor(private readonly opts: VendorStatusOptions) {}

  /** Empty base url = the operator switched vendor status off. */
  get disabled(): boolean {
    return this.opts.baseUrl.trim() === "";
  }

  /**
   * The report for THIS deployment: every vendor SPI knows, plus a per-chain
   * verdict for the (vendor, chain) pairs the mounted values file routes.
   */
  async read(use: VendorChainUse[]): Promise<VendorStatusReport> {
    if (this.disabled) {
      return {
        vendors: null,
        fetchedAt: new Date().toISOString(),
        stale: false,
        lastGoodAt: null,
        disabled: true,
      };
    }

    const listed = await this.list.read(this.opts, () => this.fetchList());
    const vendors = listed.value;
    if (vendors === null) {
      return {
        vendors: null,
        fetchedAt: new Date().toISOString(),
        stale: false,
        lastGoodAt: null,
        disabled: false,
      };
    }

    const known = new Set(vendors.map((v) => v.slug));
    const usedSlugs = [...new Set(use.map((u) => u.slug))].filter((slug) => known.has(slug));
    // Only the vendors this deployment routes through are worth a detail read.
    const reads = await Promise.all(
      usedSlugs.map(async (slug) => {
        const cached = await this.detailCache(slug).read(this.opts, () => this.fetchDetail(slug));
        return [slug, cached] as const;
      }),
    );
    const detailBySlug = new Map(reads);

    const withChains = vendors.map((vendor) => {
      const uses = use.filter((u) => u.slug === vendor.slug);
      if (uses.length === 0) return vendor;
      const detail = detailBySlug.get(vendor.slug)?.value ?? null;
      const chains: Record<string, VendorChainStatus> = {};
      for (const one of uses) {
        chains[one.spec] = chainVerdict(one.spec, one.surfaces, detail, vendor.slug);
      }
      return { ...vendor, chains };
    });

    const stale = listed.stale || reads.some(([, cached]) => cached.stale);
    return {
      vendors: withChains,
      fetchedAt: listed.fetchedAt ?? new Date().toISOString(),
      stale,
      lastGoodAt: listed.fetchedAt,
      disabled: false,
    };
  }

  private detailCache(slug: string): Cached<VendorDetail> {
    let cache = this.details.get(slug);
    if (cache === undefined) {
      cache = new Cached<VendorDetail>();
      this.details.set(slug, cache);
    }
    return cache;
  }

  private async fetchList(): Promise<VendorStatus[] | null> {
    const payload = await this.fetchJson(providerStatusUrl(this.opts.baseUrl), "the provider list");
    if (payload === undefined) return null;
    const vendors = normalizeVendors(payload);
    if (vendors === null) {
      this.opts.onError?.("status page index answered something that is not a provider list");
    }
    return vendors;
  }

  private async fetchDetail(slug: string): Promise<VendorDetail | null> {
    const payload = await this.fetchJson(providerDetailUrl(this.opts.baseUrl, slug), `vendor ${slug}`);
    if (payload === undefined) return null;
    const detail = normalizeVendorDetail(payload);
    if (detail === null) {
      this.opts.onError?.(`status page index answered no provider object for ${slug}`);
    }
    return detail;
  }

  /** `undefined` when the call itself failed — distinct from a body that
   *  parsed but wasn't the shape we expected. */
  private async fetchJson(url: string, what: string): Promise<unknown | undefined> {
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      if (!res.ok) {
        this.opts.onError?.(`status page index answered ${res.status} for ${what}`);
        return undefined;
      }
      // Throws on a body that isn't JSON — an html error page from a proxy in
      // front of SPI is the common case, and it must read as "no data".
      return await res.json();
    } catch (e) {
      this.opts.onError?.(`${describeCause(e)} reading ${what}`);
      return undefined;
    }
  }
}
