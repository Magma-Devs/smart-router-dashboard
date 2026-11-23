import { describe, expect, it } from "vitest";
import { cleanUsageProps, isUsageEventName, USAGE_EVENT_NAMES, USAGE_VIEWS, usageViewOf } from "../constants/usage-events.js";

describe("cleanUsageProps", () => {
  it("keeps the fields the catalog allows, in their form", () => {
    expect(cleanUsageProps("view_ready", { page: "metrics", tab: "errors", seconds: 4.26, reads: 3, failed: 0 }))
      .toEqual({ page: "metrics", tab: "errors", seconds: 4.3, reads: 3, failed: 0 });
    expect(cleanUsageProps("ask_question", { view: "panel", page: "metrics", new_chat: false, chain: true }))
      .toEqual({ view: "panel", page: "metrics", new_chat: false, chain: true });
    expect(cleanUsageProps("chain_pick", { chain: "ETH1", from: "list" })).toEqual({ chain: "ETH1", from: "list" });
    expect(cleanUsageProps("time_range_change", { from: "30m", to: "1d" })).toEqual({ from: "30m", to: "1d" });
  });

  it("drops a field the catalog doesn't list - an ID, typed text, a user", () => {
    expect(cleanUsageProps("row_open", { list: "errors", value: "0xabc", email: "a@b.c", request: "7708800000000000042" }))
      .toEqual({ list: "errors" });
  });

  it("drops a value not in its field's form", () => {
    expect(cleanUsageProps("view_ready", { page: "0xabc", seconds: -1, reads: "3" })).toEqual({});
    expect(cleanUsageProps("ask_question", { new_chat: "yes" })).toEqual({});
    expect(cleanUsageProps("tab_change", { from: "metrics", to: "request" })).toEqual({ from: "metrics" });
    expect(cleanUsageProps("chain_pick", { chain: "eth1; drop", from: "somewhere" })).toEqual({});
    expect(cleanUsageProps("time_range_change", { from: "2h", to: "1d" })).toEqual({ to: "1d" });
    expect(cleanUsageProps("view_ready", { seconds: 1e9, reads: 3.6 })).toEqual({ seconds: 86_400, reads: 4 });
  });

  it("keeps the time-to-information and effort events in their form", () => {
    expect(cleanUsageProps("view_ready", { page: "metrics", tab: "errors", seconds: 3.24, reads: 7, failed: 1 }))
      .toEqual({ page: "metrics", tab: "errors", seconds: 3.2, reads: 7, failed: 1 });
    expect(cleanUsageProps("help_open", { page: "metrics", tab: "metrics", text: "Requests answered" })).toEqual({ page: "metrics", tab: "metrics" });
  });

  it("refuses an event the catalog doesn't name", () => {
    expect(cleanUsageProps("password_typed", { kind: "hash" })).toBeNull();
    expect(isUsageEventName("toString")).toBe(false);
    expect(USAGE_EVENT_NAMES).toContain("view_ready");
  });

  it("names only what Mixpanel's own capture cannot see: no page views, links out, repeated clicks or visits", () => {
    for (const name of ["page_view", "link_out", "rage_click", "visit_start", "visit_end"]) {
      expect(isUsageEventName(name), name).toBe(false);
      expect(cleanUsageProps(name, {})).toBeNull();
    }
    expect([...USAGE_EVENT_NAMES].sort()).toEqual([
      "ask_answer", "ask_question",
      "chain_pick", "filter_use", "help_open", "idle_paused", "load_older", "panel_open", "router_pick",
      "row_open", "tab_change", "time_range_change", "view_problem", "view_ready",
    ]);
  });

  it("keeps Ask's events to how it was used: never the question, the answer or the chat", () => {
    expect(cleanUsageProps("ask_open", { from: "shortcut", view: "full" })).toBeNull();
    expect(cleanUsageProps("ask_question", { view: "panel", page: "metrics", new_chat: true, chain: false, question: "why is ETH1 slow?", chatId: "c-1" }))
      .toEqual({ view: "panel", page: "metrics", new_chat: true, chain: false });
    expect(cleanUsageProps("ask_question", { page: "team", chain: "ETH1" })).toEqual({});
    expect(cleanUsageProps("ask_answer", { result: "failed", error: "ASK_TIMEOUT", seconds: 41.26, sections: 3, evidence: 7, summary: "ETH1 is slow because" }))
      .toEqual({ result: "failed", error: "ASK_TIMEOUT", seconds: 41.3, sections: 3, evidence: 7 });
    expect(cleanUsageProps("ask_answer", { result: "running", error: "something the model said" })).toEqual({});
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
});
