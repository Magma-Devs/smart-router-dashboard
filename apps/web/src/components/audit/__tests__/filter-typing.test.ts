import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLocationSearch, parseAuditLocation } from "@/components/audit/audit-location";
import {
  actorAccepted,
  draftReady,
  FILTER_PAUSE_MS,
  FilterTyping,
  typedMove,
  type HistoryMode,
  type TextFilter,
} from "@/components/audit/filter-typing";

/**
 * The audit log's typed filters — MAG-5291. Each keystroke used to be a read,
 * and a Person value without its "@" yet is one the api refuses, so the page
 * flashed its error state while someone typed an address. These pin when a
 * typed value reaches the URL, and that the rule deciding it is the api's.
 */

const USER_ID = "0b6c2f4e-3a1d-4c8e-9f70-5d2b8a1e6c34";

describe("actorAccepted", () => {
  it("takes what the api takes: a user id, or anything with an @", () => {
    for (const value of [
      "dana@example.com",
      "dana@",
      "@example.com",
      USER_ID,
      USER_ID.toUpperCase(),
    ]) {
      expect(actorAccepted(value), value).toBe(true);
    }
  });

  it("refuses what the api refuses: a name, a host, part of a user id", () => {
    for (const value of ["d", "dana", "dana.example.com", USER_ID.slice(0, 20), `${USER_ID}0`]) {
      expect(actorAccepted(value), value).toBe(false);
    }
  });

  it("reads the value trimmed, as the page sends it, and an empty box as no filter", () => {
    expect(actorAccepted("  dana@example.com ")).toBe(true);
    expect(actorAccepted(` ${USER_ID} `)).toBe(true);
    expect(actorAccepted("")).toBe(true);
    expect(actorAccepted("   ")).toBe(true);
    expect(actorAccepted("  dana ")).toBe(false);
  });

  it("is the api's own rule", () => {
    // The two copies can't share code across apps, so the test reads both.
    const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
    const api = read("../../../../../api/src/routes/audit.ts");
    const web = read("../filter-typing.ts");
    const uuid = (src: string) => /const UUID = (\/.+\/i);/.exec(src)?.[1];
    expect(uuid(api)).toBeDefined();
    expect(uuid(web)).toBe(uuid(api));
    expect(api).toMatch(/if \(UUID\.test\(q\.actor\)\) actor = \{ userId: q\.actor \};\s+else if \(q\.actor\.includes\("@"\)\)/);
  });
});

describe("draftReady", () => {
  it("holds back only a Person value the api would refuse", () => {
    expect(draftReady("actor", "dana")).toBe(false);
    expect(draftReady("actor", "dana@")).toBe(true);
    // Any object id is one the api takes.
    expect(draftReady("targetId", "e")).toBe(true);
    expect(draftReady("targetId", "")).toBe(true);
  });
});

describe("FilterTyping", () => {
  let commit: ReturnType<typeof vi.fn<(field: TextFilter, value: string, how: HistoryMode) => boolean>>;
  let typing: FilterTyping;

  beforeEach(() => {
    vi.useFakeTimers();
    commit = vi.fn<(field: TextFilter, value: string, how: HistoryMode) => boolean>(() => true);
    typing = new FilterTyping({ commit });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Type `word` a letter at a time, `gapMs` apart, after the `from` letters
   *  already in the box. */
  const typeOut = (field: TextFilter, word: string, from = 0, gapMs = 80) => {
    for (let i = from + 1; i <= word.length; i++) {
      typing.type(field, word.slice(0, i));
      vi.advanceTimersByTime(gapMs);
    }
  };

  it("pauses for a little over a third of a second", () => {
    expect(FILTER_PAUSE_MS).toBeGreaterThanOrEqual(300);
    expect(FILTER_PAUSE_MS).toBeLessThanOrEqual(400);
  });

  it("sends one value when the typing stops, not one per letter", () => {
    typeOut("actor", "dana@example.com");
    expect(commit).not.toHaveBeenCalled();
    // The box shows every letter as it is typed.
    expect(typing.getDrafts()).toEqual({ actor: "dana@example.com" });

    vi.advanceTimersByTime(FILTER_PAUSE_MS);
    expect(commit.mock.calls).toEqual([["actor", "dana@example.com", "push"]]);
    // Sent: the box shows the location's value again.
    expect(typing.getDrafts()).toEqual({});
  });

  it("starts the pause again on every keystroke", () => {
    typing.type("actor", "a@");
    vi.advanceTimersByTime(FILTER_PAUSE_MS - 50);
    typing.type("actor", "ab@");
    vi.advanceTimersByTime(FILTER_PAUSE_MS - 50);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(commit.mock.calls).toEqual([["actor", "ab@", "push"]]);
  });

  it("never sends an unfinished address, however long the pause", () => {
    typeOut("actor", "dana");
    vi.advanceTimersByTime(60_000);
    expect(commit).not.toHaveBeenCalled();
    expect(typing.getDrafts()).toEqual({ actor: "dana" });

    // The "@" makes it one the api takes.
    typing.type("actor", "dana@");
    vi.advanceTimersByTime(FILTER_PAUSE_MS);
    expect(commit.mock.calls).toEqual([["actor", "dana@", "push"]]);
  });

  it("sends a finished value whatever it is, at once", () => {
    typeOut("actor", "dana");
    typing.finish("actor");
    expect(commit.mock.calls).toEqual([["actor", "dana", "push"]]);
    expect(typing.getDrafts()).toEqual({});
    // The pause that was running sends nothing more.
    vi.advanceTimersByTime(FILTER_PAUSE_MS * 2);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("sends a valid value at once when it is finished before the pause", () => {
    typing.type("actor", USER_ID);
    typing.finish("actor");
    expect(commit.mock.calls).toEqual([["actor", USER_ID, "push"]]);
  });

  it("sends nothing when a box is left with nothing typed in it", () => {
    typing.finish("actor");
    typing.finish("targetId");
    expect(commit).not.toHaveBeenCalled();
  });

  it("sends an object id after the pause, whatever it holds", () => {
    typeOut("targetId", "ep_8");
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FILTER_PAUSE_MS);
    expect(commit.mock.calls).toEqual([["targetId", "ep_8", "push"]]);
  });

  it("sends an emptied box, which removes the filter", () => {
    typing.type("actor", "");
    vi.advanceTimersByTime(FILTER_PAUSE_MS);
    expect(commit.mock.calls).toEqual([["actor", "", "push"]]);
  });

  it("keeps each box's draft and pause apart", () => {
    typing.type("actor", "dana");
    typing.type("targetId", "ep_1");
    vi.advanceTimersByTime(FILTER_PAUSE_MS);
    expect(commit.mock.calls).toEqual([["targetId", "ep_1", "push"]]);
    expect(typing.getDrafts()).toEqual({ actor: "dana" });
  });

  it("makes one history entry for one run of typing in a box", () => {
    typeOut("actor", "dana@ex");
    vi.advanceTimersByTime(FILTER_PAUSE_MS);
    typeOut("actor", "dana@example.com", "dana@ex".length);
    vi.advanceTimersByTime(FILTER_PAUSE_MS);
    typing.type("actor", "dana@example.co");
    typing.finish("actor");
    expect(commit.mock.calls.map(([, value, how]) => [value, how])).toEqual([
      ["dana@ex", "push"],
      ["dana@example.com", "replace"],
      ["dana@example.co", "replace"],
    ]);
  });

  it("starts a new entry when another box is typed in, or something else moved the page", () => {
    typing.type("actor", "dana@example.com");
    vi.advanceTimersByTime(FILTER_PAUSE_MS);
    typing.type("targetId", "ep_1");
    vi.advanceTimersByTime(FILTER_PAUSE_MS);
    typing.type("targetId", "ep_12");
    vi.advanceTimersByTime(FILTER_PAUSE_MS);
    // A group picked, a page step.
    typing.endRun();
    typing.type("targetId", "ep_123");
    vi.advanceTimersByTime(FILTER_PAUSE_MS);
    expect(commit.mock.calls.map(([field, , how]) => [field, how])).toEqual([
      ["actor", "push"],
      ["targetId", "push"],
      ["targetId", "replace"],
      ["targetId", "push"],
    ]);
  });

  it("starts no run with a value that changed nothing", () => {
    commit.mockReturnValueOnce(false);
    typing.type("actor", "");
    vi.advanceTimersByTime(FILTER_PAUSE_MS);
    typing.type("actor", "dana@example.com");
    vi.advanceTimersByTime(FILTER_PAUSE_MS);
    expect(commit.mock.calls.map(([, , how]) => how)).toEqual(["push", "push"]);
  });

  it("drops every draft and pause when the location moves under it", () => {
    typing.type("actor", "dana@example.com");
    vi.advanceTimersByTime(FILTER_PAUSE_MS);
    typing.type("actor", "dana@example.org");
    typing.type("targetId", "ep_1");
    // Back / Forward, Clear filters.
    typing.reset();
    expect(typing.getDrafts()).toEqual({});
    vi.advanceTimersByTime(FILTER_PAUSE_MS * 2);
    expect(commit).toHaveBeenCalledTimes(1);
    // And the next value is an entry of its own.
    typing.type("actor", "lee@example.com");
    vi.advanceTimersByTime(FILTER_PAUSE_MS);
    expect(commit.mock.calls.at(-1)).toEqual(["actor", "lee@example.com", "push"]);
  });

  it("hands React the same drafts until they change, and says when they do", () => {
    const changed = vi.fn();
    const unsubscribe = typing.subscribe(changed);
    const before = typing.getDrafts();
    expect(typing.getDrafts()).toBe(before);

    typing.type("actor", "d");
    expect(changed).toHaveBeenCalledTimes(1);
    expect(typing.getDrafts()).not.toBe(before);

    unsubscribe();
    typing.type("actor", "da");
    expect(changed).toHaveBeenCalledTimes(1);
    typing.reset();
  });
});

describe("typedMove", () => {
  const search = (q: string) => auditLocationSearch(parseAuditLocation(q));

  it("opens the newest page with the other filters and the page size kept", () => {
    const move = typedMove(
      "?group=people&target=ep_1&size=25&older=eyJzZXEiOjQyfQ&page=3",
      "actor",
      "dana@example.com",
      "push",
    );
    expect(move && auditLocationSearch(move.next)).toBe(
      search("?group=people&actor=dana%40example.com&target=ep_1&size=25"),
    );
    expect(move?.how).toBe("push");
  });

  it("rewrites the entry only on the newest page", () => {
    expect(typedMove("?actor=dana%40ex", "actor", "dana@example.com", "replace")?.how).toBe("replace");
    expect(
      typedMove("?actor=dana%40ex&older=eyJzZXEiOjQyfQ&page=2", "actor", "dana@example.com", "replace")?.how,
    ).toBe("push");
  });

  it("goes nowhere with the value the filter already has", () => {
    expect(typedMove("?actor=dana%40example.com&page=2&older=abc", "actor", "dana@example.com", "push")).toBeNull();
    expect(typedMove("", "targetId", "", "push")).toBeNull();
  });
});
