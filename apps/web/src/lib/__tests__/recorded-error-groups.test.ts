import { describe, expect, it } from "vitest";
import type { ErrorGroupsReport, RecordedErrorGroup } from "@sr/shared";
import { groupErrorWords, groupQuery, groupsForPick, listGroups, outcomeWords, resultsOfGroup, type ListView } from "../recorded-error-groups";

const report = (over: Partial<ErrorGroupsReport> = {}): ErrorGroupsReport => ({
  available: true, source: "recorded", grid: { start: 600, end: 4200, stepSec: 600 }, asOf: 4000, groups: [], limit: 50,
  omitted: { groups: 0, count: 0 }, total: 20, reached: { count: 12, buckets: [] }, partialFrom: 3800, ...over,
});
const view = (over: Partial<ListView> = {}): ListView => ({ picked: "auto", exactRange: false, filtered: false, loadedReached: 0, ...over });
const group = (over: Partial<RecordedErrorGroup>): RecordedErrorGroup => ({
  key: "k", spec: "ETH1", errorClass: null, outcome: "no_answer", failingProvider: "node-a", reachedClient: true, count: 1, from: 1000, to: 2000, buckets: [1], ...over,
});

describe("listGroups - the counts or the loaded requests, and what the opening pill stands for", () => {
  it("the counts, when they answer for the page window with no filter they can't apply", () => {
    expect(listGroups(report(), view())).toEqual({ source: "recorded", result: "reached" });
    for (const picked of ["all", "reached", "recovered"] as const) expect(listGroups(report(), view({ picked })).source).toBe("recorded");
  });

  it("'auto' opens on what reached the client when the window has any - by the counts, not the loaded requests", () => {
    expect(listGroups(report({ reached: { count: 0, buckets: [] } }), view({ loadedReached: 5 })).result).toBe("all");
    expect(listGroups(report(), view({ loadedReached: 0 })).result).toBe("reached");
  });

  it("the loaded requests when the counts can't answer: not available, not read yet, or not recorded", () => {
    for (const r of [undefined, null, report({ available: false, reason: "no-series" }), report({ available: false, reason: "unreachable" }), report({ source: null })]) {
      expect(listGroups(r, view({ loadedReached: 3 }))).toEqual({ source: "loaded", result: "reached" });
    }
    expect(listGroups(undefined, view()).result).toBe("all");
  });

  it("the loaded requests on picked or a bar's times, with a filter the counts don't carry, or on a result they can't tell apart", () => {
    expect(listGroups(report(), view({ exactRange: true })).source).toBe("loaded");
    expect(listGroups(report(), view({ filtered: true })).source).toBe("loaded");
    for (const picked of ["error-reply", "failed", "write-unknown", "unknown"] as const) {
      expect(listGroups(report(), view({ picked }))).toEqual({ source: "loaded", result: picked });
    }
  });
});

describe("the recorded groups a pick keeps, and the rows a group opens on", () => {
  const groups = [group({ key: "a" }), group({ key: "b", reachedClient: false, outcome: "ok" })];

  it("reached, recovered or all", () => {
    expect(groupsForPick(groups, "reached").map((g) => g.key)).toEqual(["a"]);
    expect(groupsForPick(groups, "recovered").map((g) => g.key)).toEqual(["b"]);
    expect(groupsForPick(groups, "all").map((g) => g.key)).toEqual(["a", "b"]);
  });

  it("each outcome to the list's results: a node error passed through, a router error or an unknown write, recovered", () => {
    expect([...resultsOfGroup({ outcome: "ok", reachedClient: false })]).toEqual(["recovered"]);
    expect([...resultsOfGroup({ outcome: "node_error", reachedClient: true })]).toEqual(["error-reply"]);
    expect([...resultsOfGroup({ outcome: "write_unknown", reachedClient: true })]).toEqual(["write-unknown"]);
    // A transaction the router gave up on after sending it is "outcome unknown" on the list.
    for (const outcome of ["no_answer", "rejected_before_dispatch", "router_error"]) {
      expect([...resultsOfGroup({ outcome, reachedClient: true })].sort()).toEqual(["failed", "write-unknown"]);
    }
    // An outcome the list doesn't know: its "No end logged", kept apart as the loaded groups keep it.
    expect([...resultsOfGroup({ outcome: "something_new", reachedClient: true })]).toEqual(["unknown"]);
    // A class over several outcomes: any of them.
    expect([...resultsOfGroup({ outcome: null, reachedClient: true })].sort()).toEqual(["error-reply", "failed", "unknown", "write-unknown"]);
  });

  it("opens on its minutes in ms, its failing provider and its class - empty for none", () => {
    expect(groupQuery(group({ from: 1000, to: 2000, failingProvider: "node a", errorClass: "rate_limit" })))
      .toEqual({ from: 1_000_000, to: 2_000_000, q: "&failingProvider=node%20a&errorClass=rate_limit" });
    expect(groupQuery(group({ failingProvider: null, errorClass: null })).q).toBe("&failingProvider=&errorClass=");
    // Never an empty range: the api refuses one.
    expect(groupQuery(group({ from: 1000, to: 1000 })).to).toBe(1_000_001);
  });
});

describe("a group's error in words", () => {
  it("its class, or its outcome marked unclassified - never a blank", () => {
    expect(groupErrorWords({ errorClass: "rate_limit", outcome: null })).toEqual({ label: "Rate limit", unclassified: false });
    expect(groupErrorWords({ errorClass: null, outcome: "no_answer" })).toEqual({ label: "No usable answer", unclassified: true });
    expect(groupErrorWords({ errorClass: null, outcome: null }).label).toBe("Several outcomes");
    expect(outcomeWords("something_new")).toBe("Something new");
  });
});
