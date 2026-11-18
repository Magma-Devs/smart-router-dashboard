import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* The consent banner's promise (MAG-5373): where the deployment records usage
   data, Mixpanel's SDK is not imported, started, or given anything to store
   or send until this browser accepted it, and a "no" after a "yes" stops it
   and removes everything it kept. The module is loaded fresh per test, with
   the SDK replaced by a recorder of its calls, against a browser made of maps. */

const h = vi.hoisted(() => {
  const calls: string[] = [];
  const fn = (name: string) => vi.fn((...args: unknown[]) => { calls.push(name); return args; });
  const sdk = {
    init: fn("init"),
    register: fn("register"),
    identify: fn("identify"),
    opt_in_tracking: fn("opt_in_tracking"),
    set_config: fn("set_config"),
    people: { set: fn("people.set") },
    track: fn("track"),
    stop_session_recording: fn("stop_session_recording"),
    start_session_recording: fn("start_session_recording"),
    opt_out_tracking: fn("opt_out_tracking"),
    reset: fn("reset"),
    // Asked, not done: not in `calls`.
    has_opted_in_tracking: vi.fn(() => false),
  };
  return { calls, sdk, imports: { count: 0 } };
});

const apiGet = vi.fn();
vi.mock("../api-client", () => ({ apiGet: (...a: unknown[]) => apiGet(...a) }));
vi.mock("../idle-store", () => ({ getIdlePhase: () => "active", subscribeIdle: () => () => {} }));

const ON = {
  enabled: true,
  token: "project-token",
  apiHost: "https://api-eu.mixpanel.com",
  tenant: "tenant-a",
  deploymentMode: "managed",
  version: "0.71.0",
  viewer: { id: "6f1e0c2a9b8d7e6f5a4b3c2d1e0f9a8b", staff: false, role: "admin", created: "2026-03", twoFactor: true, signIn: "password" },
};
/** Where this account's answer is kept. */
const KEY = `sr:usage-consent:2:${ON.viewer.id}`;
/** Another account on the same browser. */
const OTHER = { ...ON, viewer: { id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", staff: true, role: "read_only" } };
const OTHER_KEY = `sr:usage-consent:2:${OTHER.viewer.id}`;

function storage() {
  const kept = new Map<string, string>();
  return {
    kept,
    get length() { return kept.size; },
    key: (i: number) => [...kept.keys()][i] ?? null,
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => void kept.set(k, v),
    removeItem: (k: string) => void kept.delete(k),
  };
}

/** IndexedDB with these databases, each with two stores: what was emptied and what was deleted. */
function idb(names: string[]) {
  const have = new Set(names);
  const emptied: string[] = [];
  const deleted: string[] = [];
  return {
    emptied,
    deleted,
    have,
    factory: {
      databases: async () => [...have].map((name) => ({ name, version: 1 })),
      deleteDatabase: (name: string) => { deleted.push(name); have.delete(name); return {}; },
      open: (name: string) => {
        const req: Record<string, unknown> & { onsuccess?: () => void } = {};
        queueMicrotask(() => {
          const tx: Record<string, unknown> & { oncomplete?: () => void } = { objectStore: () => ({ clear: () => {} }) };
          req.result = {
            objectStoreNames: ["mixpanelRecordingEvents", "mixpanelRecordingRegistry"],
            transaction: () => { queueMicrotask(() => { emptied.push(name); tx.oncomplete?.(); }); return tx; },
            close: () => {},
          };
          req.onsuccess?.();
        });
        return req;
      },
    },
  };
}

let session: ReturnType<typeof storage>;
let local: ReturnType<typeof storage>;
let db: ReturnType<typeof idb>;
/** The page's listeners, by event, so a test can raise one (another tab's answer). */
let listeners: Map<string, ((e: unknown) => void)[]>;
/** The page's own `fetch`, before anything wrapped it. */
let pageFetch: () => Promise<Response>;
const raise = (type: string, e: unknown) => (listeners.get(type) ?? []).forEach((fn) => fn(e));
const settle = async () => {
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(0);
};

async function load(config: unknown, stored?: string, databases: string[] = [], before?: () => void) {
  vi.resetModules();
  // Registered per page load, so the count says whether this page imported the SDK.
  vi.doMock("mixpanel-browser", () => {
    h.imports.count++;
    return { default: h.sdk };
  });
  session = storage();
  local = storage();
  db = idb(databases);
  const who = (config as { viewer?: { id: string } }).viewer?.id ?? ON.viewer.id;
  if (stored) local.kept.set(`sr:usage-consent:2:${who}`, stored);
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("indexedDB", db.factory);
  listeners = new Map();
  pageFetch = async () => new Response("1");
  vi.stubGlobal("window", {
    fetch: pageFetch,
    location: { pathname: "/metrics", search: "?tab=request&request=0xabc", origin: "https://dash.example" },
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
  });
  apiGet.mockReset().mockResolvedValue(config);
  h.calls.length = 0;
  h.imports.count = 0;
  for (const f of [h.sdk.init, h.sdk.register, h.sdk.identify, h.sdk.opt_in_tracking, h.sdk.set_config, h.sdk.people.set, h.sdk.track, h.sdk.stop_session_recording, h.sdk.start_session_recording, h.sdk.opt_out_tracking, h.sdk.reset]) f.mockClear();
  h.sdk.has_opted_in_tracking.mockReset().mockReturnValue(false);
  before?.();
  const usage = await import("../usage");
  usage.startUsage();
  await settle();
  return usage;
}

/** What the SDK kept in this browser while it ran. */
function sdkKept() {
  local.kept.set("mp_project-token_mixpanel", "{}");
  local.kept.set("__mpq_project-token_ev", "[]");
  local.kept.set("__mp_opt_in_out_project-token", "1");
  session.kept.set("mp_tab_id_project-token", "tab");
}

const tracked = () => h.sdk.track.mock.calls.map(([name]) => name);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("before an answer", () => {
  it("imports nothing from Mixpanel, starts nothing and keeps nothing in the browser", async () => {
    const usage = await load(ON);
    expect(usage.getUsageState()).toEqual({ available: true, consent: null });
    usage.track("tab_change", { from: "metrics", to: "errors" });
    usage.noteSearchFrom("top-bar");
    await settle();
    expect(h.imports.count).toBe(0);
    expect(h.sdk.init).not.toHaveBeenCalled();
    expect([...session.kept.keys()]).toEqual([]);
    expect([...local.kept.keys()]).toEqual([]);
  });
});

describe("accepting", () => {
  it("loads the SDK once, starts it with the deployment's settings, names the viewer, then opts in", async () => {
    const usage = await load(ON);
    let wrappedAtOptIn: boolean | null = null;
    let wrappedAtInit: boolean | null = null;
    h.sdk.init.mockImplementationOnce(() => {
      h.calls.push("init");
      wrappedAtInit = window.fetch !== pageFetch;
      return [];
    });
    h.sdk.opt_in_tracking.mockImplementationOnce(() => {
      h.calls.push("opt_in_tracking");
      wrappedAtOptIn = window.fetch !== pageFetch;
      return [];
    });
    usage.track("tab_change", { from: "metrics", to: "errors" });
    usage.setUsageConsent("accepted");
    await settle();
    expect(local.kept.get(KEY)).toBe("accepted");
    expect(usage.getUsageState()).toEqual({ available: true, consent: "accepted" });
    expect(h.imports.count).toBe(1);
    const [token, options] = h.sdk.init.mock.calls[0]! as [string, Record<string, unknown>];
    expect(token).toBe("project-token");
    expect(options).toMatchObject({
      api_host: "https://api-eu.mixpanel.com",
      persistence: "localStorage",
      consent_mode: "require_consent",
      autocapture: false,
      record_sessions_percent: 100,
      record_heatmap_data: true,
      record_mask_all_text: true,
      record_mask_all_inputs: true,
      record_console: false,
      record_block_selector: "img, video, audio, .gw-no-replay",
      track_marketing: false,
      store_google: false,
      skip_first_touch_marketing: true,
    });
    expect(h.calls).toEqual(["init", "register", "identify", "opt_in_tracking", "set_config", "people.set"]);
    // The replay scrubber wraps fetch before init, where a stored opt-in starts the recording.
    expect(wrappedAtInit).toBe(true);
    expect(wrappedAtOptIn).toBe(true);
    // Whose the SDK's storage is.
    expect(local.kept.get("sr:usage-sdk-viewer")).toBe(ON.viewer.id);
    expect(h.sdk.identify).toHaveBeenCalledWith(ON.viewer.id);
    expect(h.sdk.register).toHaveBeenCalledWith({ tenant: "tenant-a", deployment_mode: "managed", dashboard_version: "0.71.0", staff: false, role: "admin" });
    expect(h.sdk.people.set).toHaveBeenCalledWith({
      $name: "tenant-a · admin · 6f1e0c2a",
      $created: "2026-03-01T00:00:00",
      tenant: "tenant-a",
      staff: false,
      role: "admin",
      two_factor: true,
      sign_in: "password",
    });
    expect(h.sdk.set_config).toHaveBeenCalledWith({ autocapture: usage.AUTOCAPTURE });
    // What came before the acceptance is not sent.
    expect(tracked()).toEqual([]);
    usage.track("chain_pick", { chain: "ETH1", from: "list", typed: "0xabc" });
    expect(h.sdk.track).toHaveBeenLastCalledWith("chain_pick", { chain: "ETH1", from: "list" });
  });

  it("never reads an element's title or labels in autocapture", async () => {
    const usage = await load(ON);
    expect(usage.AUTOCAPTURE.block_attrs).toEqual(expect.arrayContaining(["title", "aria-label", "aria-labelledby", "aria-describedby"]));
    expect(usage.AUTOCAPTURE.capture_text_content).toBe(false);
  });

  it("opts in only where the SDK is not opted in already: a stored opt-in sends no second $opt_in", async () => {
    const usage = await load(ON, "accepted", [], () => h.sdk.has_opted_in_tracking.mockReturnValue(true));
    expect(usage.getUsageState().consent).toBe("accepted");
    expect(h.sdk.identify).toHaveBeenCalledWith(ON.viewer.id);
    expect(h.calls).not.toContain("opt_in_tracking");
  });

  it("is remembered: the next page load starts the SDK and sends what waited for it", async () => {
    const usage = await load(ON, "accepted");
    expect(usage.getUsageState()).toEqual({ available: true, consent: "accepted" });
    expect(h.calls).toContain("opt_in_tracking");
    usage.track("time_range_change", { from: "30m", to: "1d" });
    expect(tracked()).toEqual(["time_range_change"]);
  });

  it("does nothing where the deployment records no usage data", async () => {
    const usage = await load({ enabled: false }, "accepted");
    expect(usage.getUsageState()).toEqual({ available: false, consent: null });
    usage.track("tab_change", { from: "metrics", to: "errors" });
    await settle();
    expect(h.imports.count).toBe(0);
    expect([...session.kept.keys()]).toEqual([]);
  });
});

describe("declining", () => {
  it("is remembered, imports nothing, and keeps only the answer", async () => {
    const usage = await load(ON);
    usage.setUsageConsent("rejected");
    usage.track("tab_change", { from: "metrics", to: "errors" });
    await settle();
    expect(h.imports.count).toBe(0);
    expect([...local.kept.entries()]).toEqual([[KEY, "rejected"]]);
    expect([...session.kept.keys()]).toEqual([]);
    const next = await load(ON, "rejected");
    expect(next.getUsageState()).toEqual({ available: true, consent: "rejected" });
    expect(h.imports.count).toBe(0);
  });

  it("on a later page load deletes whatever an earlier acceptance left, keys and databases", async () => {
    const usage = await load(ON, "rejected", ["mixpanelBrowserDb", "someone-elses-db"], sdkKept);
    expect(usage.getUsageState().consent).toBe("rejected");
    expect([...local.kept.keys()]).toEqual([KEY]);
    expect([...session.kept.keys()]).toEqual([]);
    expect(db.deleted).toEqual(["mixpanelBrowserDb"]);
    expect(h.imports.count).toBe(0);
  });
});

describe("withdrawing after an acceptance", () => {
  it("stops the recording, opts out, forgets the viewer and removes what the SDK kept", async () => {
    const usage = await load(ON, "accepted", ["mixpanelBrowserDb"], () => local.kept.set("sr:usage-sdk-viewer", ON.viewer.id));
    sdkKept();
    local.kept.set("sr:theme", "light");
    h.calls.length = 0;
    usage.setUsageConsent("rejected");
    await settle();
    expect(h.calls).toEqual(["stop_session_recording", "opt_out_tracking", "reset"]);
    expect(window.fetch, "the replay scrubber is taken off").toBe(pageFetch);
    expect([...local.kept.keys()].sort()).toEqual(["sr:theme", KEY].sort());
    expect([...session.kept.keys()]).toEqual([]);
    // The SDK still holds its database open on this page: emptied, deleted on the next load.
    expect(db.emptied).toEqual(["mixpanelBrowserDb"]);
    expect(db.deleted).toEqual([]);
    usage.track("tab_change", { from: "metrics", to: "errors" });
    expect(tracked()).toEqual([]);
  });

  it("and accepting again on the same page starts it again, without a second load", async () => {
    const usage = await load(ON, "accepted");
    usage.setUsageConsent("rejected");
    await settle();
    h.calls.length = 0;
    usage.setUsageConsent("accepted");
    await settle();
    expect(h.imports.count).toBe(1);
    expect(h.calls).toEqual(["register", "identify", "opt_in_tracking", "set_config", "people.set"]);
    usage.track("load_older", { list: "errors" });
    expect(tracked()).toEqual(["load_older"]);
  });

  it("while the SDK is still loading: it is never opted in", async () => {
    const usage = await load(ON);
    usage.setUsageConsent("accepted");
    usage.setUsageConsent("rejected");
    await settle();
    expect(h.calls).not.toContain("opt_in_tracking");
    usage.track("load_older", { list: "errors" });
    expect(tracked()).toEqual([]);
  });
});

describe("the banner's X", () => {
  it("is a no: kept, nothing imported, and the banner is not asked again", async () => {
    const usage = await load(ON);
    usage.setUsageConsent("dismissed");
    await settle();
    expect(h.imports.count).toBe(0);
    expect([...local.kept.entries()]).toEqual([[KEY, "dismissed"]]);
    expect((await load(ON, "dismissed")).getUsageState()).toEqual({ available: true, consent: "dismissed" });
  });
});

describe("an answer given in another tab", () => {
  it("holds here: an acceptance starts the SDK, a withdrawal stops it and clears what it kept", async () => {
    const usage = await load(ON);
    raise("storage", { key: KEY, newValue: "accepted" });
    await settle();
    expect(usage.getUsageState()).toEqual({ available: true, consent: "accepted" });
    expect(h.calls).toContain("opt_in_tracking");
    sdkKept();
    raise("storage", { key: KEY, newValue: "rejected" });
    await settle();
    expect(usage.getUsageState().consent).toBe("rejected");
    expect(h.calls).toContain("opt_out_tracking");
    expect([...local.kept.keys()].filter((k) => k.includes("mp"))).toEqual([]);
    usage.track("tab_change", { from: "metrics", to: "errors" });
    expect(tracked()).toEqual([]);
  });

  it("is no second start where this tab already records", async () => {
    await load(ON, "accepted");
    h.calls.length = 0;
    raise("storage", { key: KEY, newValue: "accepted" });
    await settle();
    expect(h.calls).toEqual([]);
  });

  it("is ignored for any other key, and where the deployment records nothing", async () => {
    const usage = await load(ON);
    raise("storage", { key: "sr:theme", newValue: "accepted" });
    expect(usage.getUsageState().consent).toBeNull();
    await load({ enabled: false });
    expect(listeners.get("storage") ?? []).toHaveLength(0);
  });
});

describe("the SDK's hooks", () => {
  it("redact an event's URLs before it is queued and again before it is sent", async () => {
    const usage = await load(ON);
    const { hooks } = usage.sdkOptions(ON as Parameters<typeof usage.sdkOptions>[0], "https://dash.example") as {
      hooks: Record<string, (...a: unknown[]) => unknown>;
    };
    const props = { $current_url: "https://dash.example/metrics?tab=request&request=0xabc", tenant: "tenant-a" };
    expect(hooks.on_track!("$mp_click", props)).toEqual(["$mp_click", { $current_url: "https://dash.example/metrics?tab=request&request=:id", tenant: "tenant-a" }]);
    expect(hooks.before_send_events!({ event: "$mp_click", properties: props })).toEqual({
      event: "$mp_click",
      properties: { $current_url: "https://dash.example/metrics?tab=request&request=:id", tenant: "tenant-a" },
    });
    expect(JSON.stringify(hooks.before_send_people!({ $set: { $initial_referrer: props.$current_url } }))).not.toContain("0xabc");
  });
});

describe("the stored answer", () => {
  it("is one of the three, or no answer", async () => {
    const usage = await load(ON);
    expect(usage.consentFrom("accepted")).toBe("accepted");
    expect(usage.consentFrom("rejected")).toBe("rejected");
    expect(usage.consentFrom("dismissed")).toBe("dismissed");
    for (const raw of [null, "", "true", "yes", "ACCEPTED"]) expect(usage.consentFrom(raw)).toBeNull();
    expect((await load(ON, "yes")).getUsageState()).toEqual({ available: true, consent: null });
  });

  it("allows usage data only with the deployment on and an acceptance", async () => {
    const { usageAllowed } = await load(ON);
    expect(usageAllowed(true, "accepted")).toBe(true);
    for (const [available, consent] of [[true, null], [true, "rejected"], [true, "dismissed"], [false, "accepted"], [null, "accepted"]] as const) {
      expect(usageAllowed(available, consent)).toBe(false);
    }
  });
});

describe("an answer belongs to one account and to this release", () => {
  it("is not read from 0.70.0's key, which asked about events only: the banner asks again", async () => {
    const usage = await load(ON, undefined, [], () => local.kept.set("sr:usage-consent", "accepted"));
    expect(usage.getUsageState()).toEqual({ available: true, consent: null });
    expect(h.imports.count).toBe(0);
    usage.track("tab_change", { from: "metrics", to: "errors" });
    await settle();
    expect(h.sdk.init).not.toHaveBeenCalled();
  });

  it("is not another account's: someone else signed in on this browser is asked for their own", async () => {
    const usage = await load(OTHER, undefined, [], () => local.kept.set(KEY, "accepted"));
    expect(usage.getUsageState()).toEqual({ available: true, consent: null });
    expect(h.imports.count).toBe(0);
    usage.setUsageConsent("rejected");
    expect(local.kept.get(OTHER_KEY)).toBe("rejected");
    expect(local.kept.get(KEY), "the first account's answer stays with it").toBe("accepted");
  });

  it("reaches this account's other tabs, and no other account's", async () => {
    const usage = await load(OTHER);
    raise("storage", { key: KEY, newValue: "accepted" });
    await settle();
    expect(usage.getUsageState().consent).toBeNull();
    raise("storage", { key: OTHER_KEY, newValue: "accepted" });
    await settle();
    expect(usage.getUsageState().consent).toBe("accepted");
  });
});

describe("the SDK's storage in this browser", () => {
  it("is removed before the SDK reads it when it was another account's, so no device or id is shared", async () => {
    let keptAtInit: string[] = [];
    await load(OTHER, "accepted", [], () => {
      sdkKept();
      local.kept.set("sr:usage-sdk-viewer", ON.viewer.id);
      h.sdk.init.mockImplementationOnce(() => {
        h.calls.push("init");
        keptAtInit = [...local.kept.keys(), ...session.kept.keys()].filter((k) => /^(mp_|__mp)/.test(k));
        return [];
      });
    });
    expect(h.sdk.init).toHaveBeenCalledTimes(1);
    expect(keptAtInit).toEqual([]);
    expect(local.kept.get("sr:usage-sdk-viewer")).toBe(OTHER.viewer.id);
  });

  it("is kept when it is this account's", async () => {
    let keptAtInit: string[] = [];
    await load(ON, "accepted", [], () => {
      sdkKept();
      local.kept.set("sr:usage-sdk-viewer", ON.viewer.id);
      h.sdk.init.mockImplementationOnce(() => {
        h.calls.push("init");
        keptAtInit = [...local.kept.keys()].filter((k) => /^(mp_|__mp)/.test(k));
        return [];
      });
    });
    expect(keptAtInit.length).toBeGreaterThan(0);
  });
});

describe("signing out", () => {
  it("stops the recording and makes the SDK forget the account; the answer stays with it", async () => {
    const usage = await load(ON, "accepted");
    h.calls.length = 0;
    usage.usageSignOut();
    expect(h.calls).toEqual(["set_config", "stop_session_recording", "reset"]);
    expect(h.sdk.set_config).toHaveBeenLastCalledWith({ record_sessions_percent: 0, autocapture: false });
    expect(local.kept.has("sr:usage-sdk-viewer")).toBe(false);
    expect(local.kept.get(KEY)).toBe("accepted");
    usage.track("load_older", { list: "errors" });
    expect(tracked()).toEqual([]);
  });

  it("is wired to every way out: the sidebar, the enrolment gate, sign out everywhere, and a session ended elsewhere", () => {
    const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
    for (const file of ["../../components/gateway/Shell.tsx", "../../components/auth/two-factor-gate.tsx", "../../components/account/SessionsCard.tsx"]) {
      const text = src(file);
      for (const call of text.matchAll(/signOut\(\{/g)) {
        expect(text.slice(Math.max(0, call.index! - 120), call.index), `${file}: signOut without usageSignOut before it`).toMatch(/usageSignOut\(\);\s*(await |void )?$/);
      }
    }
    expect(src("../api-client.ts")).toMatch(/usageSignOut\(\)[\s\S]{0,120}signOut\(\{ redirectTo \}\)/);
  });
});

describe("holding the replay off (the 2FA enrolment)", () => {
  it("stops the recording while held, and starts a new one when the last hold is released", async () => {
    const usage = await load(ON, "accepted");
    h.calls.length = 0;
    const a = usage.holdReplay();
    const b = usage.holdReplay();
    expect(h.calls).toEqual(["set_config", "stop_session_recording"]);
    expect(h.sdk.set_config).toHaveBeenLastCalledWith({ record_sessions_percent: 0 });
    a();
    a();
    expect(h.calls).toEqual(["set_config", "stop_session_recording"]);
    b();
    expect(h.calls).toEqual(["set_config", "stop_session_recording", "set_config", "start_session_recording"]);
    expect(h.sdk.set_config).toHaveBeenLastCalledWith({ record_sessions_percent: 100 });
  });

  it("held before an acceptance: the SDK starts with no recording", async () => {
    const usage = await load(ON);
    const release = usage.holdReplay();
    usage.setUsageConsent("accepted");
    await settle();
    const options = h.sdk.init.mock.calls[0]![1] as Record<string, unknown>;
    expect(options.record_sessions_percent).toBe(0);
    release();
    expect(h.sdk.set_config).toHaveBeenLastCalledWith({ record_sessions_percent: 100 });
    expect(h.calls.at(-1)).toBe("start_session_recording");
  });

  it("is what the enrolment panel does while it is on screen, and its QR tile is left out of every replay", async () => {
    const usage = await load(ON);
    const panel = readFileSync(fileURLToPath(new URL("../../components/auth/enrol-panel.tsx", import.meta.url)), "utf8");
    expect(panel).toMatch(/useLayoutEffect\(\(\) => holdReplay\(\), \[\]\)/);
    const options = usage.sdkOptions(ON as Parameters<typeof usage.sdkOptions>[0], "https://dash.example");
    expect(String(options.record_block_selector).split(",").map((s) => s.trim())).toContain(`.${usage.REPLAY_BLOCK_CLASS}`);
  });
});

describe("our events before the api has answered", () => {
  it("wait in memory, and go only with this account's acceptance", async () => {
    for (const [stored, sent] of [["accepted", ["tab_change"]], [undefined, []], ["rejected", []]] as const) {
      let answer!: (c: unknown) => void;
      const usage = await load(ON, stored, [], () => apiGet.mockReset().mockReturnValue(new Promise((r) => { answer = r; })));
      usage.track("tab_change", { from: "metrics", to: "errors" });
      expect(h.sdk.track).not.toHaveBeenCalled();
      answer(ON);
      await settle();
      expect(tracked(), String(stored)).toEqual(sent);
    }
  });
});

describe("Do Not Track", () => {
  it("is read as Mixpanel's SDK reads it", async () => {
    const usage = await load(ON);
    for (const [value, on] of [["1", true], ["yes", true], ["0", false], [null, false], ["unspecified", false]] as const) {
      vi.stubGlobal("window", { ...window, navigator: { doNotTrack: value } });
      expect(usage.doNotTrack(), String(value)).toBe(on);
    }
  });
});
