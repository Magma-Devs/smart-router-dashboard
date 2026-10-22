import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdleStore, type IdleStore } from "../idle-store";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 22, 9, 0, 0);

let target: EventTarget;
let visible: boolean;
let exempt: boolean;
let refresh: ReturnType<typeof vi.fn<(keys: ReadonlySet<string>) => void>>;
let store: IdleStore;

const fire = (type: string) => target.dispatchEvent(new Event(type));
const refreshedKeys = (call = 0) => [...(refresh.mock.calls[call]?.[0] ?? [])].sort();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  target = new EventTarget();
  visible = true;
  exempt = false;
  refresh = vi.fn<(keys: ReadonlySet<string>) => void>();
  store = createIdleStore({ target: () => target, visible: () => visible, refresh, exempt: () => exempt });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createIdleStore", () => {
  it("neither watches the page nor holds a poll back before anything subscribes", () => {
    vi.advanceTimersByTime(2 * 60 * MIN);
    expect(store.phaseNow()).toBe("active");
    expect(store.phase()).toBe("active");
    fire("pointermove");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("slows after 10 minutes and pauses after an hour, and tells subscribers each time", () => {
    const listener = vi.fn();
    store.subscribe(listener);
    vi.advanceTimersByTime(10 * MIN - 1);
    expect(store.phaseNow()).toBe("active");
    vi.advanceTimersByTime(1);
    expect([store.phase(), store.phaseNow(), listener.mock.calls.length]).toEqual(["slow", "slow", 1]);
    vi.advanceTimersByTime(50 * MIN);
    expect([store.phase(), store.phaseNow(), listener.mock.calls.length]).toEqual(["paused", "paused", 2]);
    vi.advanceTimersByTime(24 * 60 * MIN);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("re-reads every polling key once on the first activity after a pause, and starts the clock over", () => {
    const listener = vi.fn();
    store.subscribe(listener);
    store.watchPoll("/api/metrics/overview?window=30m");
    store.watchPoll("/api/metrics/pulse");
    vi.advanceTimersByTime(61 * MIN);
    expect(store.phase()).toBe("paused");

    fire("pointermove");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refreshedKeys()).toEqual(["/api/metrics/overview?window=30m", "/api/metrics/pulse"]);
    expect([store.phase(), store.phaseNow(), store.resumes(), listener.mock.calls.length]).toEqual(["active", "active", 1, 3]);

    // The rest of the same gesture is not another return.
    fire("pointermove");
    fire("wheel");
    vi.advanceTimersByTime(5_000);
    fire("pointerdown");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(store.resumes()).toBe(1);

    vi.advanceTimersByTime(10 * MIN);
    expect(store.phase()).toBe("slow");
  });

  it("re-reads on the first activity after a slowdown too", () => {
    store.subscribe(() => {});
    store.watchPoll("/api/metrics/chains?window=1d");
    vi.advanceTimersByTime(15 * MIN);
    fire("keydown");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(store.phase()).toBe("active");
  });

  it("returns from idle by the clock when the phase timer hasn't fired yet", () => {
    store.subscribe(() => {});
    store.watchPoll("/k");
    vi.setSystemTime(T0 + 2 * 60 * MIN); // the clock jumps; no timer has run
    expect([store.phase(), store.phaseNow()]).toEqual(["active", "paused"]);
    fire("touchstart");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(store.phaseNow()).toBe("active");
  });

  it("puts the slowdown off while someone is at the page, without a re-read", () => {
    store.subscribe(() => {});
    store.watchPoll("/k");
    vi.advanceTimersByTime(9 * MIN);
    fire("pointermove");
    vi.advanceTimersByTime(2 * MIN);
    expect(store.phase()).toBe("active");
    vi.advanceTimersByTime(8 * MIN);
    expect(store.phase()).toBe("slow");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("counts a tab coming back into view, not one going away", () => {
    store.subscribe(() => {});
    vi.advanceTimersByTime(61 * MIN);
    visible = false;
    fire("visibilitychange");
    expect(store.phase()).toBe("paused");
    visible = true;
    fire("visibilitychange");
    expect(store.phase()).toBe("active");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("counts focus, and Back or Forward, as activity", () => {
    store.subscribe(() => {});
    vi.advanceTimersByTime(61 * MIN);
    fire("focus");
    expect(store.phase()).toBe("active");
    vi.advanceTimersByTime(61 * MIN);
    fire("popstate");
    expect(store.phase()).toBe("active");
  });

  it("never slows or pauses an exempt page, and re-reads nothing there", () => {
    exempt = true;
    store.subscribe(() => {});
    store.watchPoll("/api/metrics/overview?window=30m");
    for (const after of [11 * MIN, 61 * MIN, 24 * 60 * MIN]) {
      vi.setSystemTime(T0 + after);
      vi.advanceTimersByTime(0);
      expect([store.phase(), store.phaseNow()]).toEqual(["active", "active"]);
    }
    fire("pointermove");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps an exempt page's clock, so leaving it counts from the last activity there", () => {
    exempt = true;
    store.subscribe(() => {});
    vi.advanceTimersByTime(3 * 60 * MIN);
    fire("pointerdown"); // the click that leaves the page
    exempt = false;
    expect(store.phaseNow()).toBe("active");
    vi.advanceTimersByTime(10 * MIN);
    expect(store.phase()).toBe("slow");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps re-reading a key while any panel still polls it", () => {
    store.subscribe(() => {});
    const unwatchA = store.watchPoll("/shared");
    const unwatchB = store.watchPoll("/shared");
    unwatchA();
    vi.advanceTimersByTime(61 * MIN);
    fire("pointermove");
    expect(refreshedKeys(0)).toEqual(["/shared"]);

    unwatchB();
    vi.advanceTimersByTime(61 * MIN);
    fire("pointermove");
    expect(refreshedKeys(1)).toEqual([]);
  });

  it("stops watching when the last subscriber leaves, and starts a fresh clock for the next", () => {
    const first = vi.fn();
    const off = store.subscribe(first);
    vi.advanceTimersByTime(61 * MIN);
    expect(store.phaseNow()).toBe("paused");
    off();
    expect([store.phase(), store.phaseNow()]).toEqual(["active", "active"]);
    fire("pointermove");
    vi.advanceTimersByTime(3 * 60 * MIN);
    expect(refresh).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledTimes(2);

    const second = vi.fn();
    store.subscribe(second);
    expect(store.phaseNow()).toBe("active");
    vi.advanceTimersByTime(9 * MIN);
    expect(store.phase()).toBe("active");
    vi.advanceTimersByTime(MIN);
    expect(store.phase()).toBe("slow");
    expect(second).toHaveBeenCalledTimes(1);
  });
});
