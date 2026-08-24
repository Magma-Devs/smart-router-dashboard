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

/* ── The outbound budget. The index allows 30 requests a minute per IP, and
   the detail layer is the only part that fans out (one read per vendor this
   deployment routes), so it is the only part that can blow it. ───────────── */

/** At most this many detail reads dial out at once. */
const DETAIL_CONCURRENCY = 4;
/** Each dialling read waits up to this long first, so a refresh is a trickle. */
const DETAIL_STAGGER_MS = 120;
/** Consecutive detail failures that read as "the index is down, not this one
 *  vendor" and trip the breaker. */
const DETAIL_CIRCUIT_FAILURES = 3;
/** How long the whole detail layer stays parked once the breaker trips. */
const DETAIL_CIRCUIT_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

/**
 * One detail payload → the components, or **null when the body is not a
 * provider at all**.
 *
 * The null matters: a 200 carrying `{}` or `{"detail":"Not Found"}` used to
 * parse into "status unknown, no components", which the verdict then reported
 * as "no component maps to this chain" — a confident answer derived from
 * nothing, cached for a minute. A body with neither a status word nor a
 * components array is a failed read and says so.
 */
export function normalizeVendorDetail(payload: unknown): VendorDetail | null {
  const rec = record(payload);
  if (rec === null) return null;
  const official = record(rec.official);
  const raw = official?.components ?? rec.components;
  const status = statusWord(str(rec.official_status) ?? str(official?.status));
  if (status === null && !Array.isArray(raw)) return null;

  const components: VendorChainComponent[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const comp = record(entry);
    const name = str(comp?.name);
    if (name === null) continue;
    components.push({ name, status: statusWord(str(comp?.status)) ?? "unknown" });
  }
  return { officialStatus: status ?? "unknown", components };
}

/** A cause phrase safe to log — never a stack. */
function describeCause(e: unknown): string {
  const cause = (e as { cause?: { code?: string } } | undefined)?.cause;
  if (cause?.code) return cause.code;
  if (e instanceof Error) return e.name === "TimeoutError" ? "timed out" : e.message || e.name;
  return "unknown error";
}

/** What a cached slot hands back: the value, when it was read, and whether
 *  the latest attempt to refresh it FAILED. */
interface CachedValue<T> {
  value: T | null;
  fetchedAt: string | null;
  /** The data is the last good one because a refresh failed — NOT merely
   *  because the TTL turned over. Routine expiry is invisible to a reader:
   *  with a 60s TTL and a 60s poll it happens on every single request, and a
   *  "the index is unreachable" note that shows up every minute is a lie the
   *  reader learns to ignore. */
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

  /** Whether a refresh would run right now — the fan-out budget asks first. */
  wouldRefresh(opts: { ttlMs: number; failureTtlMs: number }): boolean {
    const now = Date.now();
    const fresh = this.value !== null && now - this.fetchedAtMs < opts.ttlMs;
    const backingOff = this.lastAttemptFailed && now - this.lastAttemptMs < opts.failureTtlMs;
    return !fresh && !backingOff;
  }

  /** True while there is nothing good to serve — such a reader has to wait. */
  get empty(): boolean {
    return this.value === null;
  }

  async read(
    opts: { ttlMs: number; failureTtlMs: number; skipRefresh?: boolean },
    load: () => Promise<T | null>,
  ): Promise<CachedValue<T>> {
    const hasValue = this.value !== null;
    if (this.wouldRefresh(opts) && opts.skipRefresh !== true) {
      const refresh = this.refresh(load);
      // Nothing good to serve yet ⇒ the caller waits. Otherwise the last good
      // value goes out now and the refresh lands for the next reader.
      if (!hasValue) await refresh;
    }
    return {
      value: this.value,
      fetchedAt: this.fetchedAtIso,
      stale: this.value !== null && this.lastAttemptFailed,
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
  /** Consecutive detail failures across vendors, and the breaker they trip. */
  private detailFailures = 0;
  private circuitOpenUntilMs = 0;
  /** Per-key stamp of the last warn, so a failing index logs once a window. */
  private readonly warnedAtMs = new Map<string, number>();

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
    // Only the vendors this deployment routes through are worth a detail read,
    // and even those go out under a budget — see `readDetails`.
    const reads = await this.readDetails(usedSlugs);
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

  /**
   * The detail reads for this deployment's vendors, under a budget.
   *
   * The naive version — `Promise.all` over every used slug, each with its own
   * 10s failure backoff — is a retry storm against a service that allows 30
   * requests a minute per IP: twenty vendors failing meant ~120 requests and
   * ~120 warn lines a minute, which guarantees the 429s that keep them
   * failing. Three things bound it:
   *
   *  - **concurrency + jitter**: at most `DETAIL_CONCURRENCY` in flight, each
   *    offset slightly, so a healthy refresh is a trickle rather than twenty
   *    simultaneous connections;
   *  - **a shared circuit breaker**: consecutive detail failures across
   *    vendors (the signature of "the index is down", not "one vendor 404s")
   *    park the whole detail layer for `DETAIL_CIRCUIT_MS`. Cached details
   *    keep being served; vendors with none report the honest reason;
   *  - **log throttling**: one warn per vendor per backoff window, so an
   *    outage costs a line a minute rather than a wall of them.
   */
  private async readDetails(slugs: string[]): Promise<(readonly [string, CachedValue<VendorDetail>])[]> {
    const results: (readonly [string, CachedValue<VendorDetail>])[] = new Array(slugs.length);
    let next = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        const slug = slugs[index];
        if (slug === undefined) return;
        const cache = this.detailCache(slug);
        // Re-read the breaker per slug, not once per pass: the failures that
        // trip it happen DURING this fan-out, and a pass that checked only at
        // the start would send all twenty before noticing the first three.
        if (!this.circuitOpen() && slugs.length > 1 && cache.wouldRefresh(this.opts)) {
          // Spread the requests that will actually leave the process; a cached
          // read costs nothing and is never delayed.
          await sleep(Math.random() * DETAIL_STAGGER_MS);
        }
        results[index] = [
          slug,
          await cache.read({ ...this.opts, skipRefresh: this.circuitOpen() }, () => this.fetchDetail(slug)),
        ] as const;
      }
    };

    // A reader with nothing cached still has to wait for its own read, so the
    // workers are awaited; the cap is on how many dial out at once.
    await Promise.all(
      Array.from({ length: Math.min(DETAIL_CONCURRENCY, slugs.length) }, () => worker()),
    );
    return results;
  }

  private detailCache(slug: string): Cached<VendorDetail> {
    let cache = this.details.get(slug);
    if (cache === undefined) {
      cache = new Cached<VendorDetail>();
      this.details.set(slug, cache);
    }
    return cache;
  }

  /** The detail layer is parked: serve what is cached, dial nothing. */
  private circuitOpen(): boolean {
    return Date.now() < this.circuitOpenUntilMs;
  }

  /** Count a detail read's outcome towards the circuit breaker. */
  private noteDetailOutcome(ok: boolean): void {
    if (ok) {
      this.detailFailures = 0;
      this.circuitOpenUntilMs = 0;
      return;
    }
    this.detailFailures += 1;
    if (this.detailFailures >= DETAIL_CIRCUIT_FAILURES) {
      this.circuitOpenUntilMs = Date.now() + DETAIL_CIRCUIT_MS;
    }
  }

  /** One warn per key per backoff window — an outage should cost a line a
   *  minute, not a line per request. */
  private warnThrottled(key: string, reason: string): void {
    const now = Date.now();
    const last = this.warnedAtMs.get(key) ?? 0;
    if (now - last < this.opts.failureTtlMs) return;
    this.warnedAtMs.set(key, now);
    this.opts.onError?.(reason);
  }

  private async fetchList(): Promise<VendorStatus[] | null> {
    const payload = await this.fetchJson("list", providerStatusUrl(this.opts.baseUrl), "the provider list");
    if (payload === undefined) return null;
    const vendors = normalizeVendors(payload);
    if (vendors === null) {
      this.warnThrottled("list", "status page index answered something that is not a provider list");
    }
    return vendors;
  }

  private async fetchDetail(slug: string): Promise<VendorDetail | null> {
    const payload = await this.fetchJson(slug, providerDetailUrl(this.opts.baseUrl, slug), `vendor ${slug}`);
    const detail = payload === undefined ? null : normalizeVendorDetail(payload);
    if (payload !== undefined && detail === null) {
      this.warnThrottled(slug, `status page index answered no provider object for ${slug}`);
    }
    this.noteDetailOutcome(detail !== null);
    return detail;
  }

  /** `undefined` when the call itself failed — distinct from a body that
   *  parsed but wasn't the shape we expected. */
  private async fetchJson(key: string, url: string, what: string): Promise<unknown | undefined> {
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      if (!res.ok) {
        this.warnThrottled(key, `status page index answered ${res.status} for ${what}`);
        return undefined;
      }
      // Throws on a body that isn't JSON — an html error page from a proxy in
      // front of SPI is the common case, and it must read as "no data".
      return await res.json();
    } catch (e) {
      this.warnThrottled(key, `${describeCause(e)} reading ${what}`);
      return undefined;
    }
  }
}
