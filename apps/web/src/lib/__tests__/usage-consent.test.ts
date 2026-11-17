import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* The consent bar's promise (MAG-5373): where the deployment sends usage data,
   nothing is recorded, sent or kept in the browser until this browser accepted
   it, and a rejection stops it again. The module is loaded fresh per test,
   against a browser made of maps. */

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock("../api-client", () => ({
  ApiError: class ApiError extends Error {},
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPost: (...a: unknown[]) => apiPost(...a),
  apiPostKeepalive: vi.fn(),
}));
vi.mock("../idle-store", () => ({ getIdlePhase: () => "active", subscribeIdle: () => () => {} }));

function storage() {
  const kept = new Map<string, string>();
  return {
    kept,
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => void kept.set(k, v),
    removeItem: (k: string) => void kept.delete(k),
  };
}

let session: ReturnType<typeof storage>;
let local: ReturnType<typeof storage>;

async function load(apiSays: boolean, stored?: string) {
  vi.resetModules();
  session = storage();
  local = storage();
  if (stored) local.kept.set("sr:usage-consent", stored);
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("window", {
    location: { pathname: "/metrics", search: "" },
    innerWidth: 1400,
    addEventListener: () => {},
    getSelection: () => null,
  });
  vi.stubGlobal("document", { documentElement: { getAttribute: () => "dark" }, addEventListener: () => {}, visibilityState: "visible" });
  apiGet.mockReset().mockResolvedValue({ enabled: apiSays });
  apiPost.mockReset().mockResolvedValue({ accepted: 1 });
  const usage = await import("../usage");
  usage.startUsage();
  await vi.advanceTimersByTimeAsync(0);
  return usage;
}

/** Every event name posted so far, in order. */
const posted = () => apiPost.mock.calls.flatMap(([, body]) => (body as { events: { name: string }[] }).events.map((e) => e.name));
const sendWindow = () => vi.advanceTimersByTimeAsync(10_000);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("before an answer", () => {
  it("records nothing, sends nothing and keeps nothing in the browser", async () => {
    const usage = await load(true);
    expect(usage.getUsageState()).toEqual({ available: true, consent: null });
    usage.track("page_view", { page: "metrics", tab: "metrics" });
    usage.track("tab_change", { from: "metrics", to: "errors" });
    usage.noteSearchFrom("top-bar");
    await sendWindow();
    expect(apiPost).not.toHaveBeenCalled();
    expect([...session.kept.keys()]).toEqual([]);
    expect([...local.kept.keys()]).toEqual([]);
  });
});

describe("accepting", () => {
  it("starts a visit from that moment: what came before is not sent", async () => {
    const usage = await load(true);
    usage.track("tab_change", { from: "metrics", to: "errors" });
    usage.setUsageConsent("accepted");
    expect(local.kept.get("sr:usage-consent")).toBe("accepted");
    expect(usage.getUsageState()).toEqual({ available: true, consent: "accepted" });
    await sendWindow();
    expect(apiPost).toHaveBeenCalledWith("/api/usage", expect.objectContaining({ visit: expect.any(String) }));
    expect(posted().slice(0, 2)).toEqual(["visit_start", "page_view"]);
    expect(posted()).not.toContain("tab_change");
    expect(session.kept.has("sr:visit")).toBe(true);
  });

  it("is remembered: the next page load sends without asking", async () => {
    const usage = await load(true, "accepted");
    expect(usage.getUsageState()).toEqual({ available: true, consent: "accepted" });
    usage.track("page_view", { page: "metrics", tab: "metrics" });
    await sendWindow();
    expect(posted()).toContain("page_view");
  });

  it("does nothing where the deployment sends no usage data", async () => {
    const usage = await load(false, "accepted");
    expect(usage.getUsageState()).toEqual({ available: false, consent: null });
    usage.track("page_view", { page: "metrics", tab: "metrics" });
    await sendWindow();
    expect(apiPost).not.toHaveBeenCalled();
    expect([...session.kept.keys()]).toEqual([]);
  });
});

describe("rejecting", () => {
  it("is remembered, and nothing is recorded or kept", async () => {
    const usage = await load(true);
    usage.setUsageConsent("rejected");
    usage.track("page_view", { page: "metrics", tab: "metrics" });
    await sendWindow();
    expect(apiPost).not.toHaveBeenCalled();
    expect([...local.kept.entries()]).toEqual([["sr:usage-consent", "rejected"]]);
    expect([...session.kept.keys()]).toEqual([]);
    expect((await load(true, "rejected")).getUsageState()).toEqual({ available: true, consent: "rejected" });
  });

  it("after accepting stops it: what waited is dropped and the visit is removed from the browser", async () => {
    const usage = await load(true, "accepted");
    usage.track("page_view", { page: "metrics", tab: "metrics" });
    expect(session.kept.has("sr:visit")).toBe(true);
    usage.setUsageConsent("rejected");
    expect(session.kept.has("sr:visit")).toBe(false);
    usage.track("tab_change", { from: "metrics", to: "errors" });
    await sendWindow();
    expect(apiPost).not.toHaveBeenCalled();
  });
});

describe("the stored answer", () => {
  it("is one of the two, or no answer", async () => {
    const usage = await load(true);
    expect(usage.consentFrom("accepted")).toBe("accepted");
    expect(usage.consentFrom("rejected")).toBe("rejected");
    for (const raw of [null, "", "true", "yes", "ACCEPTED"]) expect(usage.consentFrom(raw)).toBeNull();
    expect((await load(true, "yes")).getUsageState()).toEqual({ available: true, consent: null });
  });

  it("allows sending only with the deployment on and an acceptance", async () => {
    const { usageAllowed } = await load(true);
    expect(usageAllowed(true, "accepted")).toBe(true);
    for (const [available, consent] of [[true, null], [true, "rejected"], [false, "accepted"], [null, "accepted"]] as const) {
      expect(usageAllowed(available, consent)).toBe(false);
    }
  });
});
