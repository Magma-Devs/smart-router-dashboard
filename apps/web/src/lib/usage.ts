"use client";
/**
 * Usage data (MAG-5373), through Mixpanel's browser SDK: autocapture (page
 * views, clicks, inputs, scrolls, submits, dead and rage clicks), session
 * replay with text and inputs masked, heatmaps and a profile per signed-in
 * user, plus the catalog's own events that autocapture can't see (`track`).
 *
 * Nothing from Mixpanel is imported, loaded, stored or sent unless the api
 * says usage data is on (`GET /api/usage/config`: accounts on, the
 * deployment's switch, a token, a signed-in user) AND the signed-in person
 * accepted it in the consent banner (`UsageConsentBar`). The SDK is then
 * loaded as its own chunk and sends to the configured EU host only. The
 * answer is kept in `localStorage` per account and per consent version
 * (`consentKey`), reaches the browser's other tabs of the dashboard, and the
 * Account page changes it; a "no" after a "yes" stops the SDK and removes
 * everything it kept, and signing out (`usageSignOut`) stops it and makes it
 * forget the account.
 *
 * Every URL and clicked element an event carries is redacted first
 * (`usage-redact.ts`), and every session replay upload is scrubbed the same
 * way before it is sent (`usage-replay.ts`, loaded with the SDK). The 2FA
 * enrolment is never recorded (`holdReplay`, `REPLAY_BLOCK_CLASS`). Every
 * call here is safe to make before the answer is known, on the server, or
 * while it is off: it does nothing.
 */
import type { AutocaptureConfig, Config, Mixpanel } from "mixpanel-browser";
import {
  cleanUsageProps,
  USAGE_ASK_ERRORS,
  type AskRun,
  type Role,
  type UsageEventName,
  type UsageProps,
} from "@sr/shared";
import { apiGet } from "./api-client";
import { getIdlePhase, subscribeIdle } from "./idle-store";
import { redactProfileUpdate, redactUsageEvent, redactUsageProps } from "./usage-redact";

/**
 * The consent banner's wording this release asks under. An answer stored
 * under another version (0.70.0's `sr:usage-consent`, which asked about
 * events only, never session replays) is not read: the banner asks again.
 */
export const CONSENT_VERSION = 2;

/** Where this browser keeps one signed-in person's answer: another account on the same browser is asked for its own. */
export const consentKey = (viewerId: string): string => `sr:usage-consent:${CONSENT_VERSION}:${viewerId}`;

/** Whose usage data the SDK's storage in this browser holds: another account's is removed before the SDK reads it. */
const SDK_VIEWER_KEY = "sr:usage-sdk-viewer";

/** An element with this class, and everything inside it, is left out of every session replay (the 2FA QR). */
export const REPLAY_BLOCK_CLASS = "gw-no-replay";

/** What `GET /api/usage/config` answers. */
export type UsageConfig =
  | { enabled: false }
  | {
      enabled: true;
      token: string;
      apiHost: string;
      tenant: string;
      deploymentMode: "managed" | "onprem";
      version: string;
      viewer: UsageViewer;
    };
/** The signed-in person as usage data names them (`apps/api/src/services/usage.ts`). */
export interface UsageViewer {
  id: string;
  staff: boolean;
  role: Role;
  /** Staff only: a customer's address is never in the answer. */
  email?: string;
  /** The month the account was made, `YYYY-MM`. */
  created: string | null;
  twoFactor: boolean | null;
  signIn: "password" | "google" | "github" | "invite" | "other" | null;
}
type OnConfig = Extract<UsageConfig, { enabled: true }>;

export function pageOf(pathname: string): "metrics" | "upstreams" | "team" | "audit" | "account" | "standalone" | "ask" | "other" {
  const first = pathname.split("/")[1] ?? "";
  return first === "metrics" || first === "upstreams" || first === "team" || first === "audit" || first === "account" || first === "standalone" || first === "ask"
    ? first
    : "other";
}

/**
 * What the viewer's profile says about them. `$name` makes the Users list
 * readable: a staff member's address, else `<tenant> · <role> · <id prefix>`.
 * `$email` is set for staff only, so a customer's profile never holds one.
 */
export function profileOf(c: { tenant: string; viewer: UsageViewer }): Record<string, string | boolean> {
  const v = c.viewer;
  const out: Record<string, string | boolean> = {
    $name: v.staff && v.email ? v.email : `${c.tenant} · ${v.role} · ${v.id.slice(0, 8)}`,
    tenant: c.tenant,
    staff: v.staff,
    role: v.role,
  };
  if (v.staff && v.email) out.$email = v.email;
  if (v.created && /^\d{4}-\d{2}$/.test(v.created)) out.$created = `${v.created}-01T00:00:00`;
  if (typeof v.twoFactor === "boolean") out.two_factor = v.twoFactor;
  if (v.signIn) out.sign_in = v.signIn;
  return out;
}

export function tabOf(pathname: string, search: string): string {
  if (pageOf(pathname) !== "metrics") return "none";
  return new URLSearchParams(search).get("tab") ?? "metrics";
}

/**
 * How an Ask run ended, as `ask_answer` says it: the status, the error code
 * (one the catalog lists, else "other"), the seconds from sending to the end,
 * and how many sections and evidence rows the answer had. Never the question
 * or the answer's text. Null for a run that has not ended.
 */
export function askAnswerProps(run: Pick<AskRun, "status" | "createdAt" | "completedAt" | "error" | "answer">): UsageProps | null {
  if (run.status !== "succeeded" && run.status !== "failed" && run.status !== "cancelled" && run.status !== "interrupted") return null;
  const code = run.error?.code;
  const props: UsageProps = { result: run.status };
  if (code) props.error = (USAGE_ASK_ERRORS as readonly string[]).includes(code) ? code : "other";
  const seconds = run.completedAt ? (Date.parse(run.completedAt) - Date.parse(run.createdAt)) / 1000 : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) props.seconds = seconds;
  if (run.answer) {
    props.sections = run.answer.sections.length;
    props.evidence = run.answer.evidence.length;
  }
  return props;
}

/**
 * What the person at this browser answered the consent banner. "dismissed" is
 * its X: a "no", kept like "rejected", so the banner does not come back.
 */
export type UsageConsent = "accepted" | "rejected" | "dismissed";

/** The stored answer, or null when none was given: anything else in the key is no answer. */
export function consentFrom(raw: string | null): UsageConsent | null {
  return raw === "accepted" || raw === "rejected" || raw === "dismissed" ? raw : null;
}

/** Usage data is recorded only where the deployment has it on and this browser accepted it. */
export function usageAllowed(available: boolean | null, consent: UsageConsent | null): boolean {
  return available === true && consent === "accepted";
}

/**
 * What autocapture records. Text content stays off: a click says which
 * element, never what it read. The SDK never reads an element's title or
 * labels (`block_attrs`): in this UI they carry hashes, request IDs, customer
 * ids and the signed-in person's address.
 */
export const AUTOCAPTURE = {
  pageview: "url-with-path",
  click: true,
  dead_click: true,
  rage_click: true,
  input: true,
  scroll: true,
  submit: true,
  capture_text_content: false,
  block_attrs: ["title", "aria-label", "aria-labelledby", "aria-describedby"],
} satisfies AutocaptureConfig;

/**
 * The SDK's options for a deployment's config, `origin` being this page's.
 * `require_consent` keeps the SDK from storing or sending anything until
 * `opt_in_tracking()`, and holds a withdrawal in memory once its stored flag
 * is removed. The console stays out of replays: an api error's message can
 * name an address, and the console is not masked. The SDK copies no campaign
 * tags or ad click ids out of the page's address (`track_marketing`,
 * `store_google`, `skip_first_touch_marketing`).
 */
export function sdkOptions(config: OnConfig, origin: string): Partial<Config> & { track_marketing: boolean } {
  const hooks = {
    on_track: (name: string, props: Record<string, unknown>) => [name, redactUsageProps(props, origin)],
    before_send_events: (event: { event: string; properties: Record<string, unknown> }) => redactUsageEvent(event, origin),
    before_send_people: (update: Record<string, unknown>) => redactProfileUpdate(update, origin),
  };
  return {
    api_host: config.apiHost,
    persistence: "localStorage",
    consent_mode: "require_consent",
    save_referrer: false,
    // Autocapture starts after the opt-in (`begin`), so its first page view is sent.
    autocapture: false,
    record_sessions_percent: 100,
    record_heatmap_data: true,
    record_mask_all_text: true,
    record_mask_all_inputs: true,
    record_block_selector: `img, video, audio, .${REPLAY_BLOCK_CLASS}`,
    record_console: false,
    track_marketing: false,
    store_google: false,
    skip_first_touch_marketing: true,
    hooks: hooks as Config["hooks"],
  };
}

/** Whether this browser sends Do Not Track, read as Mixpanel's SDK reads it: the SDK then sends nothing, whatever the answer. */
export function doNotTrack(): boolean {
  if (typeof window === "undefined") return false;
  const nav = (window.navigator ?? {}) as { doNotTrack?: unknown; msDoNotTrack?: unknown };
  const values = [nav.doNotTrack, nav.msDoNotTrack, (window as unknown as { doNotTrack?: unknown }).doNotTrack];
  return values.some((v) => v === true || v === 1 || v === "1" || v === "yes");
}

/** Whether this deployment sends usage data, and what this browser answered. */
export interface UsageState {
  /** Null until the api has answered. */
  available: boolean | null;
  consent: UsageConsent | null;
}

const UNKNOWN: UsageState = { available: null, consent: null };
let state: UsageState = UNKNOWN;
const watchers = new Set<() => void>();

export function subscribeUsage(fn: () => void): () => void {
  watchers.add(fn);
  return () => watchers.delete(fn);
}
export const getUsageState = (): UsageState => state;
export const getServerUsageState = (): UsageState => UNKNOWN;

function setState(next: UsageState) {
  state = next;
  for (const fn of watchers) fn();
}

/** The signed-in person's stored answer; none before the api has said who they are. */
function readConsent(): UsageConsent | null {
  if (!config) return null;
  try {
    return consentFrom(localStorage.getItem(consentKey(config.viewer.id)));
  } catch {
    return null;
  }
}

let started = false;
let config: OnConfig | null = null;
let sdk: Mixpanel | null = null;
let loading: Promise<Mixpanel> | null = null;
let replay: typeof import("./usage-replay") | null = null;
/** Takes the replay scrubber off `fetch` again. */
let unscrub: (() => void) | null = null;
/** Whether the SDK is opted in on this page. */
let recording = false;
let listening = false;
/** Our events from before the SDK is ready, in memory only, while the answer is unknown or "accepted"; dropped on any other answer. */
let pending: [UsageEventName, Record<string, string | number | boolean>][] = [];
const PENDING_MAX = 50;
/** Set as the page unloads: reads cut short by leaving are not problems. */
let leaving = false;
/** Views already reported as failed or slow on this page. */
const problemsSeen = new Set<string>();

/** Record one of the catalog's events. Does nothing on the server, or while usage data is off or not accepted. */
export function track(name: UsageEventName, props: UsageProps = {}): void {
  if (typeof window === "undefined") return;
  if (name === "tab_change") viewOpened("metrics", String(props.to ?? "metrics"));
  const clean = cleanUsageProps(name, props);
  if (!clean) return;
  if (sdk && recording) {
    sdk.track(name, clean);
    return;
  }
  const waiting = state.available === null || (state.available && state.consent === "accepted");
  if (waiting && pending.length < PENDING_MAX) pending.push([name, clean]);
}

function readSdkViewer(): string | null {
  try {
    return localStorage.getItem(SDK_VIEWER_KEY);
  } catch {
    return null;
  }
}

/**
 * The SDK and the replay scrubber, loaded once per page; the SDK started.
 * What the SDK kept for another account is removed first, and the scrubber
 * wraps `fetch` before `init`: a stored opt-in starts the recording inside it.
 */
function load(c: OnConfig): Promise<Mixpanel> {
  loading ??= Promise.all([import("mixpanel-browser"), import("./usage-replay")]).then(async ([{ default: mixpanel }, scrubber]) => {
    replay = scrubber;
    if (readSdkViewer() !== c.viewer.id) await forgetSdkStorage(false);
    try {
      localStorage.setItem(SDK_VIEWER_KEY, c.viewer.id);
    } catch {
      /* storage blocked: the SDK keeps nothing either */
    }
    unscrub ??= scrubber.installReplayScrubber(c.apiHost, window.location.origin);
    mixpanel.init(c.token, { ...sdkOptions(c, window.location.origin), record_sessions_percent: replayHolds > 0 ? 0 : 100 });
    sdk = mixpanel;
    return mixpanel;
  });
  return loading;
}

/** Starts usage data: loads the SDK if need be, names the viewer, opts in, and sends what waited. */
async function begin(): Promise<void> {
  const c = config;
  if (!c) return;
  let mp: Mixpanel;
  try {
    mp = await load(c);
  } catch {
    return;
  }
  // Answered "no" while the SDK loaded.
  if (!usageAllowed(state.available, state.consent) || recording) return;
  mp.register({ tenant: c.tenant, deployment_mode: c.deploymentMode, dashboard_version: c.version, staff: c.viewer.staff, role: c.viewer.role });
  mp.identify(c.viewer.id);
  // A new acceptance after a "no" on this page: the scrubber went with the "no".
  unscrub ??= replay!.installReplayScrubber(c.apiHost, window.location.origin);
  // A stored opt-in already started the SDK in `init`; a second one would send `$opt_in` again.
  if (!mp.has_opted_in_tracking()) mp.opt_in_tracking();
  // Autocapture set up again with tracking allowed: it sends this page's view.
  mp.set_config({ autocapture: AUTOCAPTURE });
  mp.people.set(profileOf(c));
  recording = true;
  for (const [name, props] of pending) mp.track(name, props);
  pending = [];
  listen();
}

/** The page's own listeners, set up once and quiet while usage data is off. */
function listen() {
  if (listening) return;
  listening = true;
  // The browser cuts a leaving page's reads off just before pagehide, so
  // leaving starts at beforeunload - and ends again if the page stayed (a
  // cancelled navigation, a download) or came back from the back-forward cache.
  window.addEventListener("beforeunload", () => {
    leaving = true;
    setTimeout(() => { leaving = false; }, 3_000);
  });
  window.addEventListener("pageshow", () => { leaving = false; });
  window.addEventListener("pagehide", () => { leaving = true; });
  let wasPaused = false;
  subscribeIdle(() => {
    const paused = getIdlePhase() === "paused";
    if (paused && !wasPaused) {
      const loc = window.location;
      track("idle_paused", { page: pageOf(loc.pathname), tab: tabOf(loc.pathname, loc.search) });
    }
    wasPaused = paused;
  });
}

/** Where the SDK keeps what it records: these localStorage / sessionStorage key prefixes and IndexedDB databases. */
const SDK_KEY = /^(mp_|__mp)/;
export const SDK_DATABASES = ["mixpanelBrowserDb", "mixpanelFlagsDb"] as const;

function forgetKeys(store: Storage) {
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k && SDK_KEY.test(k)) keys.push(k);
  }
  for (const k of keys) store.removeItem(k);
}

/** Empties an existing database's stores. */
function emptyDatabase(idb: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve) => {
    const open = idb.open(name);
    open.onupgradeneeded = () => open.transaction?.abort();
    open.onerror = () => resolve();
    open.onsuccess = () => {
      const db = open.result;
      const stores = Array.from(db.objectStoreNames);
      if (stores.length === 0) {
        db.close();
        resolve();
        return;
      }
      const tx = db.transaction(stores, "readwrite");
      for (const s of stores) tx.objectStore(s).clear();
      tx.oncomplete = tx.onerror = tx.onabort = () => {
        db.close();
        resolve();
      };
    };
  });
}

/**
 * The SDK's databases: emptied while this page's SDK holds them open, since a
 * delete would wait for the page to go and hold up the SDK's next open (a
 * replay after a new acceptance); deleted where no SDK ran on the page, which
 * is every later page load after a "no".
 */
async function forgetDatabases(heldOpen: boolean): Promise<void> {
  const idb = typeof indexedDB === "undefined" ? null : indexedDB;
  if (!idb) return;
  let names: readonly string[] = SDK_DATABASES;
  try {
    if (typeof idb.databases === "function") {
      const have = new Set((await idb.databases()).map((d) => d.name));
      names = SDK_DATABASES.filter((n) => have.has(n));
    }
  } catch {
    /* unlisted: each is deleted below, which creates nothing */
  }
  for (const name of names) {
    if (heldOpen) await emptyDatabase(idb, name);
    else idb.deleteDatabase(name);
  }
}

/** Removes everything the SDK kept in this browser, and whose it was. */
export async function forgetSdkStorage(heldOpen = false): Promise<void> {
  try {
    forgetKeys(localStorage);
    forgetKeys(sessionStorage);
    localStorage.removeItem(SDK_VIEWER_KEY);
  } catch {
    /* storage blocked: nothing was kept */
  }
  await forgetDatabases(heldOpen);
}

let replayHolds = 0;

function applyReplayHold(held: boolean) {
  const mp = sdk;
  if (!mp) return;
  try {
    mp.set_config({ record_sessions_percent: held ? 0 : 100 });
    // Opted out or Do Not Track: the SDK starts nothing.
    if (held) mp.stop_session_recording();
    else mp.start_session_recording();
  } catch {
    /* the SDK's own failure: nothing is recorded */
  }
}

/**
 * Keeps the session replay off while something that must never be recorded
 * is on screen (the 2FA enrolment and its QR): the recording stops, and no
 * new one starts until the last hold is released, when a new replay starts.
 * Returns the release.
 */
export function holdReplay(): () => void {
  replayHolds++;
  if (replayHolds === 1) applyReplayHold(true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    replayHolds--;
    if (replayHolds === 0) applyReplayHold(false);
  };
}

/**
 * Signing out: the recording stops, and the SDK forgets this account (a new
 * device id) and whose its storage was, so the next account on this browser
 * starts from nothing. The account's answer stays with it.
 */
export function usageSignOut(): void {
  pending = [];
  recording = false;
  const mp = sdk;
  if (mp) {
    try {
      mp.set_config({ record_sessions_percent: 0, autocapture: false });
      mp.stop_session_recording();
      mp.reset();
    } catch {
      /* the next page load removes what the SDK kept */
    }
  }
  try {
    localStorage.removeItem(SDK_VIEWER_KEY);
  } catch {
    /* storage blocked: nothing was kept */
  }
}

/** Stops usage data: the recording stops, the SDK opts out and forgets the viewer, and what it kept is removed. */
function stop() {
  pending = [];
  const mp = sdk;
  const was = recording;
  recording = false;
  if (mp && was) {
    try {
      mp.stop_session_recording();
      mp.opt_out_tracking();
      mp.reset();
    } catch {
      /* the storage below goes either way */
    }
  }
  unscrub?.();
  unscrub = null;
  void forgetSdkStorage(mp !== null);
}

/**
 * Asks the api once whether usage data is on and, if it is and this browser
 * accepted it, starts it. Called by the shell on its first render; later
 * calls do nothing.
 */
export function startUsage(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  apiGet<UsageConfig>("/api/usage/config")
    .then((c) => {
      config = c.enabled === true ? c : null;
      const available = config !== null;
      const consent = available ? readConsent() : null;
      setState({ available, consent });
      if (usageAllowed(available, consent)) void begin();
      else stop();
      // An answer this account gave in another tab holds here too: the
      // banner goes, and usage data starts or stops with it.
      if (config) {
        const key = consentKey(config.viewer.id);
        window.addEventListener("storage", (e) => {
          if (e.key === key) applyConsent(consentFrom(e.newValue));
        });
      }
    })
    .catch(() => {
      setState({ available: false, consent: null });
      stop();
    });
}

/**
 * The signed-in person's answer to the consent banner, or its change on the
 * Account page. Kept in `localStorage` under their account
 * (`consentKey`), the only thing written before an acceptance. Accepting
 * starts usage data from this moment: nothing from before it is sent. A "no"
 * stops it and removes what the SDK kept.
 */
export function setUsageConsent(choice: UsageConsent): void {
  if (typeof window === "undefined") return;
  if (config) {
    try {
      localStorage.setItem(consentKey(config.viewer.id), choice);
    } catch {
      /* private window: the answer holds until the page is closed */
    }
  }
  applyConsent(choice);
}

/** An answer, from this page or another tab: the banner follows it, and usage data starts or stops. */
function applyConsent(choice: UsageConsent | null) {
  const was = state.consent;
  setState({ available: state.available, consent: choice });
  if (!usageAllowed(state.available, choice)) {
    stop();
    return;
  }
  if (was === "accepted" && recording) return;
  void begin();
}

/** Reads that failed or answered slowly, once per view a page load. */
export function trackViewProblem(path: string, problem: "did-not-load" | "slow", seconds: number): void {
  if (leaving) return;
  const key = `${problem}:${path.split("?")[0]}`;
  if (problemsSeen.has(key)) return;
  problemsSeen.add(key);
  track("view_problem", { view: path, problem, seconds });
}

/* Time to information (`view_ready`): from a page or tab opening until the
   reads it opened with have answered. A view's reads are the ones started
   from just before it opened (its components fetch as they mount, a moment
   before the shell notes the page) to 2 s after; polls after that, and a
   previous view's slow reads, are not its own. The first view of a page load
   takes every read in flight and is timed from when the browser started
   loading. A view that started no read came from the cache: ready at 1.5 s. */
const VIEW_LEAD_MS = 500;
const VIEW_OPEN_MS = 2_000;
let readSeq = 0;
const inflightAt = new Map<number, number>();
let view: { page: string; tab: string; start: number; opened: number; pending: Set<number>; reads: number; failed: number; done: boolean } | null = null;
let cacheTimer: ReturnType<typeof setTimeout> | null = null;
let firstView = true;
let lastView = { key: "", at: 0 };

/** A page or a tab opened: times it until its reads have answered. The same view twice in a row is one. */
export function viewOpened(page: string, tab: string): void {
  const now = Date.now();
  const key = `${page}|${tab}`;
  if (key === lastView.key && now - lastView.at < 2_000) return;
  lastView = { key, at: now };
  const first = firstView;
  firstView = false;
  const pendingReads = new Set<number>();
  for (const [id, t] of inflightAt) if (first || t >= now - VIEW_LEAD_MS) pendingReads.add(id);
  const start = first && typeof performance !== "undefined" ? Math.round(performance.timeOrigin) : now;
  view = { page, tab, start, opened: now, pending: pendingReads, reads: pendingReads.size, failed: 0, done: false };
  if (cacheTimer) clearTimeout(cacheTimer);
  const mine = view;
  cacheTimer = setTimeout(() => {
    if (view === mine && !mine.done && mine.reads === 0) finishView(mine);
  }, 1_500);
}

function finishView(v: NonNullable<typeof view>) {
  v.done = true;
  track("view_ready", { page: v.page, tab: v.tab, seconds: (Date.now() - v.start) / 1000, reads: v.reads, failed: v.failed });
}

/** A read began; returns its handle for `readEnded`. */
export function readStarted(): number {
  const id = ++readSeq;
  const now = Date.now();
  inflightAt.set(id, now);
  if (view && !view.done && now - view.opened <= VIEW_OPEN_MS) {
    view.pending.add(id);
    view.reads++;
  }
  return id;
}

export function readEnded(id: number, ok: boolean): void {
  inflightAt.delete(id);
  if (!view || view.done || leaving || !view.pending.has(id)) return;
  view.pending.delete(id);
  if (!ok) view.failed++;
  if (view.pending.size === 0) finishView(view);
}
