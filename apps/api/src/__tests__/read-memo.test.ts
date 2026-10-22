import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadMemo, remember } from "../services/read-memo.js";

describe("ReadMemo", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A read that settles when told to, counting how often it ran. */
  function reader(value: string, keepMs: number) {
    const runs: ((v: { value: string; keepMs: number }) => void)[] = [];
    const read = () => new Promise<{ value: string; keepMs: number }>((settle) => { runs.push(settle); });
    return { read, runs, done: () => runs.at(-1)!({ value, keepMs }) };
  }

  it("everyone asking while a read runs gets that read", async () => {
    const memo = new ReadMemo<string>(4);
    const r = reader("a", 1000);
    const asked = [memo.get("k", r.read), memo.get("k", r.read), memo.get("k", r.read)];
    r.done();
    expect(await Promise.all(asked)).toEqual(["a", "a", "a"]);
    expect(r.runs).toHaveLength(1);
  });

  it("keeps an answer as long as its read says, then reads again", async () => {
    const memo = new ReadMemo<string>(4);
    const r = reader("a", 1000);
    const first = memo.get("k", r.read);
    r.done();
    await first;
    vi.setSystemTime(1_000_999);
    expect(await memo.get("k", r.read)).toBe("a");
    expect(r.runs).toHaveLength(1);
    vi.setSystemTime(1_001_000);
    const again = memo.get("k", r.read);
    r.done();
    await again;
    expect(r.runs).toHaveLength(2);
  });

  it("an answer to keep for 0 isn't kept, and a read that throws is kept by no one", async () => {
    const memo = new ReadMemo<string>(4);
    const r = reader("a", 0);
    const first = memo.get("k", r.read);
    r.done();
    await first;
    const second = memo.get("k", r.read);
    r.done();
    await second;
    expect(r.runs).toHaveLength(2);
    const failing = () => Promise.reject(new Error("boom"));
    await expect(Promise.all([memo.get("x", failing), memo.get("x", failing)])).rejects.toThrow("boom");
    const ok = reader("b", 1000);
    const after = memo.get("x", ok.read);
    ok.done();
    expect(await after).toBe("b");
  });

  it("keeps at most `max` answers, the oldest dropped first", async () => {
    const memo = new ReadMemo<string>(2);
    for (const k of ["a", "b", "c"]) {
      const r = reader(k, 60_000);
      const got = memo.get(k, r.read);
      r.done();
      await got;
    }
    let reads = 0;
    const count = async () => { reads += 1; return { value: "again", keepMs: 60_000 }; };
    expect(await memo.get("c", count)).toBe("c");
    expect(await memo.get("b", count)).toBe("b");
    expect(await memo.get("a", count)).toBe("again");
    expect(reads).toBe(1);
  });
});

describe("remember", () => {
  it("makes the key set the newest and drops the oldest past `max`", () => {
    const m = new Map<string, number>();
    remember(m, "a", 1, 2);
    remember(m, "b", 2, 2);
    remember(m, "a", 3, 2);
    remember(m, "c", 4, 2);
    expect([...m]).toEqual([["a", 3], ["c", 4]]);
  });
});
