import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SnapshotStore, type SnapshotLogger } from "../services/snapshot.js";

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
const TTL = 15_000;

/** Lets queued microtasks (a run starting, a run settling) happen. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A run answering 1, 2, 3, … and counting itself. */
function counter() {
  let n = 0;
  return { run: async () => ++n, runs: () => n };
}

/** A run that waits until the test releases it. */
function gated<T>() {
  let runs = 0;
  const waiting: ((value: T) => void)[] = [];
  return {
    run: () => {
      runs++;
      return new Promise<T>((resolve) => waiting.push(resolve));
    },
    runs: () => runs,
    release: (value: T) => waiting.shift()!(value),
  };
}

function capture(): { logger: SnapshotLogger; lines: { obj: Record<string, unknown>; msg: string }[] } {
  const lines: { obj: Record<string, unknown>; msg: string }[] = [];
  return { logger: { warn: (obj, msg) => void lines.push({ obj, msg }) }, lines };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => vi.useRealTimers());

describe("SnapshotStore", () => {
  it("serves every caller within the TTL from one run", async () => {
    const store = new SnapshotStore();
    const { run, runs } = counter();
    expect(await store.get("k", TTL, run)).toEqual({ value: 1, at: T0 });
    for (const dt of [1, 7_000, TTL - 1]) {
      vi.setSystemTime(T0 + dt);
      expect(await store.get("k", TTL, run)).toEqual({ value: 1, at: T0 });
    }
    expect(runs()).toBe(1);
  });

  it("concurrent callers share the one run in flight", async () => {
    const store = new SnapshotStore();
    const g = gated<string>();
    const callers = Array.from({ length: 5 }, () => store.get("k", TTL, g.run));
    await tick();
    expect(g.runs()).toBe(1);
    g.release("answer");
    expect((await Promise.all(callers)).map((s) => s.value)).toEqual(Array(5).fill("answer"));
    expect(g.runs()).toBe(1);
  });

  it("keys are separate answers", async () => {
    const store = new SnapshotStore();
    const { run, runs } = counter();
    expect((await store.get("a", TTL, run)).value).toBe(1);
    expect((await store.get("b", TTL, run)).value).toBe(2);
    expect((await store.get("a", TTL, run)).value).toBe(1);
    expect(runs()).toBe(2);
  });

  it("past the TTL serves the kept answer while one refresh runs, then the new one", async () => {
    const store = new SnapshotStore();
    const g = gated<string>();
    const first = store.get("k", TTL, g.run);
    await tick();
    g.release("first");
    await first;

    vi.setSystemTime(T0 + TTL + 5_000);
    // Nobody waits: the kept answer, with the time its read started.
    expect(await store.get("k", TTL, g.run)).toEqual({ value: "first", at: T0 });
    await tick();
    expect(g.runs()).toBe(2);
    // While the refresh runs, every caller still gets the kept answer and no second run starts.
    vi.setSystemTime(T0 + TTL + 6_000);
    expect(await store.get("k", TTL, g.run)).toEqual({ value: "first", at: T0 });
    await tick();
    expect(g.runs()).toBe(2);

    g.release("second");
    await store.idle();
    expect(await store.get("k", TTL, g.run)).toEqual({ value: "second", at: T0 + TTL + 5_000 });
    expect(g.runs()).toBe(2);
  });

  it("twice the TTL old, a caller waits for a fresh run", async () => {
    const store = new SnapshotStore();
    const { run, runs } = counter();
    await store.get("k", TTL, run);
    vi.setSystemTime(T0 + 2 * TTL);
    expect(await store.get("k", TTL, run)).toEqual({ value: 2, at: T0 + 2 * TTL });
    expect(runs()).toBe(2);
  });

  it("a failed refresh keeps the last good answer, bounded, retried after the cool-down only", async () => {
    const { logger, lines } = capture();
    const store = new SnapshotStore({ retryAfterMs: 5_000, logger });
    let failing = false;
    let runs = 0;
    const run = async () => {
      runs++;
      if (failing) throw new Error("store down");
      return runs;
    };
    expect((await store.get("k", TTL, run)).value).toBe(1);

    failing = true;
    vi.setSystemTime(T0 + 16_000);
    expect(await store.get("k", TTL, run)).toEqual({ value: 1, at: T0 });
    await store.idle();
    expect(runs).toBe(2);

    // The cool-down: the last good answer, and no run on any of these.
    for (const at of [16_500, 18_000, 20_999]) {
      vi.setSystemTime(T0 + at);
      expect(await store.get("k", TTL, run)).toEqual({ value: 1, at: T0 });
    }
    await store.idle();
    expect(runs).toBe(2);

    // Past it, one more try, still behind the last good answer.
    vi.setSystemTime(T0 + 21_000);
    expect((await store.get("k", TTL, run)).value).toBe(1);
    await store.idle();
    expect(runs).toBe(3);

    // Twice the TTL old it is served no more: the caller waits for a run and gets its error…
    vi.setSystemTime(T0 + 2 * TTL);
    await expect(store.get("k", TTL, run)).rejects.toThrow("store down");
    expect(runs).toBe(4);
    // …and within the cool-down, that error again, without a run.
    vi.setSystemTime(T0 + 2 * TTL + 4_999);
    await expect(store.get("k", TTL, run)).rejects.toThrow("store down");
    expect(runs).toBe(4);

    failing = false;
    vi.setSystemTime(T0 + 2 * TTL + 5_000);
    expect(await store.get("k", TTL, run)).toEqual({ value: 5, at: T0 + 2 * TTL + 5_000 });
    // One line for the whole run of failures.
    expect(lines).toHaveLength(1);
    expect(lines[0]!.obj).toMatchObject({ key: "k", keptAgeMs: 16_000 });
  });

  it("a first run that fails reaches every caller sharing it, and is not retried within the cool-down", async () => {
    const store = new SnapshotStore({ retryAfterMs: 5_000 });
    let runs = 0;
    const run = async (): Promise<number> => {
      runs++;
      throw new Error("boom");
    };
    await Promise.all([
      expect(store.get("k", TTL, run)).rejects.toThrow("boom"),
      expect(store.get("k", TTL, run)).rejects.toThrow("boom"),
    ]);
    expect(runs).toBe(1);

    vi.setSystemTime(T0 + 4_999);
    await expect(store.get("k", TTL, run)).rejects.toThrow("boom");
    expect(runs).toBe(1);
    vi.setSystemTime(T0 + 5_000);
    await expect(store.get("k", TTL, run)).rejects.toThrow("boom");
    expect(runs).toBe(2);
  });

  it("the cool-down is never longer than the TTL", async () => {
    const store = new SnapshotStore({ retryAfterMs: 60_000 });
    let runs = 0;
    const run = async (): Promise<number> => {
      runs++;
      throw new Error("boom");
    };
    await expect(store.get("k", 1_000, run)).rejects.toThrow("boom");
    vi.setSystemTime(T0 + 1_000);
    await expect(store.get("k", 1_000, run)).rejects.toThrow("boom");
    expect(runs).toBe(2);
  });

  it("past the cap the least recently refreshed key goes first", async () => {
    const store = new SnapshotStore({ maxEntries: 2 });
    const { run, runs } = counter();
    await store.get("a", TTL, run);
    vi.setSystemTime(T0 + 1_000);
    await store.get("b", TTL, run);

    // Refreshing "a" moves it behind "b".
    vi.setSystemTime(T0 + TTL + 500);
    await store.get("a", TTL, run);
    await store.idle();
    expect(runs()).toBe(3);

    await store.get("c", TTL, run);
    expect(store.size).toBe(2);
    expect(runs()).toBe(4);
    // "a" and "c" are kept; "b" was evicted and reads again.
    expect((await store.get("a", TTL, run)).value).toBe(3);
    expect((await store.get("c", TTL, run)).value).toBe(4);
    expect(runs()).toBe(4);
    expect((await store.get("b", TTL, run)).value).toBe(5);
    expect(store.size).toBe(2);
  });

  it("never evicts a key with a run in flight", async () => {
    const store = new SnapshotStore({ maxEntries: 1 });
    const g = gated<number>();
    const pending = store.get("a", TTL, g.run);
    await tick();
    await store.get("b", TTL, async () => 2);
    expect(store.size).toBe(2);
    // A caller for "a" still joins its run rather than starting another.
    const joined = store.get("a", TTL, g.run);
    g.release(1);
    expect((await pending).value).toBe(1);
    expect((await joined).value).toBe(1);
    expect(g.runs()).toBe(1);
  });

  it("a TTL of 0 runs every time and keeps nothing", async () => {
    const store = new SnapshotStore();
    const { run, runs } = counter();
    expect(await store.get("k", 0, run)).toEqual({ value: 1, at: T0 });
    expect(await store.get("k", 0, run)).toEqual({ value: 2, at: T0 });
    expect(runs()).toBe(2);
    expect(store.size).toBe(0);
  });
});
