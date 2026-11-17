import { describe, expect, it } from "vitest";
import { cleanUsageProps, isUsageEventName, USAGE_EVENT_NAMES, USAGE_VIEWS, USAGE_VISIT_ID, usageViewOf } from "../constants/usage-events.js";

describe("cleanUsageProps", () => {
  it("keeps the fields the catalog allows, in their form", () => {
    expect(cleanUsageProps("search", { kind: "hash", from: "top-bar", result: "found", seconds: 4.26, older: false }))
      .toEqual({ kind: "hash", from: "top-bar", result: "found", seconds: 4.3, older: false });
    expect(cleanUsageProps("chain_pick", { chain: "ETH1", from: "list" })).toEqual({ chain: "ETH1", from: "list" });
    expect(cleanUsageProps("time_range_change", { from: "30m", to: "1d" })).toEqual({ from: "30m", to: "1d" });
  });

  it("drops a field the catalog doesn't list - an ID, typed text, a user", () => {
    expect(cleanUsageProps("search", { kind: "hash", value: "0xabc", email: "a@b.c", request: "7708800000000000042" }))
      .toEqual({ kind: "hash" });
  });

  it("drops a value not in its field's form", () => {
    expect(cleanUsageProps("search", { kind: "0xabc", seconds: -1, older: "yes" })).toEqual({});
    expect(cleanUsageProps("chain_pick", { chain: "eth1; drop", from: "somewhere" })).toEqual({});
    expect(cleanUsageProps("time_range_change", { from: "2h", to: "1d" })).toEqual({ to: "1d" });
    expect(cleanUsageProps("visit_end", { seconds: 1e9, events: 3.6 })).toEqual({ seconds: 86_400, events: 4 });
  });

  it("keeps the time-to-information and effort events in their form", () => {
    expect(cleanUsageProps("view_ready", { page: "metrics", tab: "errors", seconds: 3.24, reads: 7, failed: 1 }))
      .toEqual({ page: "metrics", tab: "errors", seconds: 3.2, reads: 7, failed: 1 });
    expect(cleanUsageProps("visit_start", { screen: "laptop", theme: "light", arrived: "typed" }))
      .toEqual({ screen: "laptop", theme: "light", arrived: "typed" });
    expect(cleanUsageProps("help_open", { page: "metrics", tab: "metrics", text: "Requests answered" })).toEqual({ page: "metrics", tab: "metrics" });
  });

  it("refuses an event the catalog doesn't name", () => {
    expect(cleanUsageProps("password_typed", { kind: "hash" })).toBeNull();
    expect(isUsageEventName("toString")).toBe(false);
    expect(USAGE_EVENT_NAMES).toContain("visit_start");
  });

  it("takes ids out of an api path, so a view never carries one", () => {
    expect(usageViewOf("/api/metrics/upstreams?window=1d&spec=ETH1")).toBe("/api/metrics/upstreams");
    expect(usageViewOf("/api/requests/0xabcdef0123")).toBe("/api/requests/:id");
    expect(usageViewOf("/api/transactions/7708800000000000042?window=30d")).toBe("/api/transactions/:id");
    expect(usageViewOf("/api/transactions/over-time?window=1d")).toBe("/api/transactions/over-time");
    expect(usageViewOf("https://example.com/api/x")).toBeNull();
    expect(cleanUsageProps("view_problem", { view: "/api/requests/abc123", problem: "slow", seconds: 12 }))
      .toEqual({ view: "/api/requests/:id", problem: "slow", seconds: 12 });
  });

  it("never keeps what was typed into a look-up, whatever it is made of", () => {
    // A client's own request ID is any text: words and hyphens read like a path.
    for (const typed of ["john-smith", "acmebank-withdrawal", "order", "errors", "My Order", "a/b", "%2Fapi%2Fmetrics%2Fchains"]) {
      expect(usageViewOf(`/api/requests/${encodeURIComponent(typed)}?window=30d`)).toBe("/api/requests/:id");
      expect(usageViewOf(`/api/transactions/${encodeURIComponent(typed)}`)).toBe("/api/transactions/:id");
    }
    expect(usageViewOf("/api/requests/a/b")).toBeNull();
  });

  it("a view is one of the listed reads, or nothing", () => {
    for (const view of USAGE_VIEWS) expect(usageViewOf(`${view}?window=1d`)).toBe(view);
    expect(usageViewOf("/api/metrics/not-a-read")).toBeNull();
    expect(usageViewOf("/api/metrics")).toBeNull();
    expect(usageViewOf("/api/")).toBeNull();
    expect(cleanUsageProps("view_problem", { view: "/api/metrics/not-a-read", problem: "slow", seconds: 12 }))
      .toEqual({ problem: "slow", seconds: 12 });
  });

  it("a visit id is random lower-case characters, nothing else", () => {
    expect(USAGE_VISIT_ID.test("3f2c9a1e-7b4d-4c3e-9a1f-0d2e5b6c7a8f")).toBe(true);
    expect(USAGE_VISIT_ID.test("omer@example.com")).toBe(false);
  });
});
