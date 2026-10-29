import { describe, expect, it } from "vitest";
import {
  focusFromSearch, hasFocus, LOG_SPAN_MS, NO_FOCUS, sameFocus, spanFromSearch, spanNotice, VIEW_KEYS,
  viewParams, windowFromSearch, windowNotice, type ViewFocus,
} from "../view-in-url";
import { ROUTER_TOKEN, SPEC_TOKEN } from "../chain-drawer";

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const HOUR = 3_600_000;

describe("windowFromSearch", () => {
  it("reads a window the page offers", () => {
    expect(windowFromSearch("?window=7d")).toEqual({ window: "7d", unknown: null });
    expect(windowFromSearch("?window=30m")).toEqual({ window: "30m", unknown: null });
  });

  it("reads the 24h alias as 1d", () => {
    expect(windowFromSearch("?window=24h")).toEqual({ window: "1d", unknown: null });
  });

  it("names nothing when the URL has no window", () => {
    expect(windowFromSearch("?chain=ETH1")).toEqual({ window: null, unknown: null });
    expect(windowFromSearch("?window=")).toEqual({ window: null, unknown: null });
  });

  it("says what it was when it isn't a window, cut short", () => {
    expect(windowFromSearch("?window=2y")).toEqual({ window: null, unknown: "2y" });
    expect(windowFromSearch(`?window=${"x".repeat(80)}`).unknown).toHaveLength(32);
  });
});

describe("spanFromSearch", () => {
  const span = (from: number | string, to: number | string) => spanFromSearch(`?from=${from}&to=${to}`, NOW);

  it("reads times inside the last 30 days as they are", () => {
    expect(span(NOW - 2 * HOUR, NOW - HOUR)).toEqual({ range: { from: NOW - 2 * HOUR, to: NOW - HOUR }, note: null });
  });

  it("names nothing when the URL has no times", () => {
    expect(spanFromSearch("?upstream=node-a", NOW)).toEqual({ range: null, note: null });
  });

  it("can't read one end alone, non-numbers, the wrong order, a future start, or over 30 days", () => {
    expect(spanFromSearch(`?from=${NOW - HOUR}`, NOW).note).toBe("unreadable");
    expect(span("abc", NOW).note).toBe("unreadable");
    expect(span(-5, NOW).note).toBe("unreadable");
    expect(span(NOW - HOUR, NOW - 2 * HOUR).note).toBe("unreadable");
    expect(span(NOW - HOUR, NOW - HOUR).note).toBe("unreadable");
    expect(span(NOW + HOUR, NOW + 2 * HOUR).note).toBe("unreadable");
    expect(span(NOW - LOG_SPAN_MS - HOUR, NOW).note).toBe("unreadable");
    expect(span(NOW - 2 * HOUR, NOW).range).not.toBeNull();
  });

  it("reads times that ended over 30 days ago as none: the logs are gone", () => {
    expect(span(NOW - LOG_SPAN_MS - 2 * HOUR, NOW - LOG_SPAN_MS - HOUR)).toEqual({ range: null, note: "expired" });
  });

  it("starts times that began over 30 days ago at 30 days ago", () => {
    expect(span(NOW - LOG_SPAN_MS - HOUR, NOW - LOG_SPAN_MS + HOUR)).toEqual({
      range: { from: NOW - LOG_SPAN_MS, to: NOW - LOG_SPAN_MS + HOUR }, note: "clipped",
    });
  });

  it("keeps an end still in the future - a bar still filling - for the api to cap", () => {
    expect(span(NOW - HOUR, NOW + 60_000).range).toEqual({ from: NOW - HOUR, to: NOW + 60_000 });
  });
});

describe("focusFromSearch", () => {
  const full = `?chain=ETH1&upstream=node-a&upstreamChain=BASE&from=${NOW - HOUR}&to=${NOW}&expand=eth-prod&tile=err`;

  it("reads only the keys the tab owns", () => {
    expect(focusFromSearch(full, "metrics", NOW).focus).toEqual({ ...NO_FOCUS, expand: "eth-prod", tile: "err" });
    expect(focusFromSearch(full, "upstreams", NOW).focus).toEqual({ ...NO_FOCUS, upstream: { name: "node-a", spec: "BASE" } });
    expect(focusFromSearch(full, "errors", NOW).focus).toEqual({
      ...NO_FOCUS, upstream: { name: "node-a", spec: "ETH1" }, range: { from: NOW - HOUR, to: NOW },
    });
    expect(focusFromSearch(full, "transactions", NOW).focus).toEqual(NO_FOCUS);
  });

  it("takes an upstream's chain from the page's when the URL doesn't name its own", () => {
    expect(focusFromSearch("?chain=ETH1&upstream=node-a", "upstreams", NOW).focus.upstream).toEqual({ name: "node-a", spec: "ETH1" });
    expect(focusFromSearch("?upstream=node-a", "upstreams", NOW).focus.upstream).toEqual({ name: "node-a", spec: null });
  });

  it("refuses an upstream that is a URL, or carries control characters", () => {
    expect(focusFromSearch("?upstream=https%3A%2F%2Fnode.example%2Fkey", "upstreams", NOW).focus.upstream).toBeNull();
    expect(focusFromSearch("?upstream=a%0Ab", "upstreams", NOW).focus.upstream).toBeNull();
    expect(focusFromSearch(`?upstream=${"n".repeat(201)}`, "upstreams", NOW).focus.upstream).toBeNull();
  });

  it("reads a tile only with its row, and a malformed one as none", () => {
    expect(focusFromSearch("?tile=err", "metrics", NOW).focus).toEqual(NO_FOCUS);
    expect(focusFromSearch("?expand=eth-prod&tile=%3Cb%3E", "metrics", NOW).focus).toEqual({ ...NO_FOCUS, expand: "eth-prod" });
    expect(focusFromSearch("?expand=%3Cb%3E", "metrics", NOW).focus).toEqual(NO_FOCUS);
  });

  it("passes on why a link's times weren't read as they are", () => {
    const old = `?upstream=node-a&from=${NOW - LOG_SPAN_MS - 2 * HOUR}&to=${NOW - LOG_SPAN_MS - HOUR}`;
    const read = focusFromSearch(old, "errors", NOW);
    expect(read.span).toBe("expired");
    expect(read.focus).toEqual({ ...NO_FOCUS, upstream: { name: "node-a", spec: null } });
    expect(focusFromSearch(old, "upstreams", NOW).span).toBeNull();
  });
});

describe("viewParams", () => {
  const focus: ViewFocus = {
    upstream: { name: "node-a", spec: "ETH1" }, range: { from: 1000.4, to: 2000.6 }, expand: "eth-prod", tile: "p95",
  };

  it("names every key, the window always, a tab's focus only on that tab", () => {
    expect(viewParams("metrics", focus, "ETH1", "7d")).toEqual({
      window: "7d", upstream: null, upstreamChain: null, from: null, to: null, expand: "eth-prod", tile: "p95",
    });
    expect(viewParams("upstreams", focus, "ETH1", "30m")).toEqual({
      window: "30m", upstream: "node-a", upstreamChain: null, from: null, to: null, expand: null, tile: null,
    });
    expect(viewParams("errors", focus, "ETH1", "30m")).toEqual({
      window: "30m", upstream: "node-a", upstreamChain: null, from: "1000", to: "2001", expand: null, tile: null,
    });
    expect(viewParams("transactions", focus, "ETH1", "30m")).toEqual({
      window: "30m", upstream: null, upstreamChain: null, from: null, to: null, expand: null, tile: null,
    });
    expect(Object.keys(viewParams("metrics", NO_FOCUS, null, "30m")).sort()).toEqual([...VIEW_KEYS].sort());
  });

  it("names an upstream's chain only when the page's chain doesn't", () => {
    expect(viewParams("upstreams", focus, null, "30m").upstreamChain).toBe("ETH1");
    expect(viewParams("upstreams", focus, "BASE", "30m").upstreamChain).toBe("ETH1");
    expect(viewParams("upstreams", { ...focus, upstream: { name: "node-a", spec: null } }, null, "30m").upstreamChain).toBeNull();
  });

  it("leaves the window as it is until it is known", () => {
    expect(viewParams("metrics", NO_FOCUS, null, undefined).window).toBeUndefined();
  });

  it("leaves a tile out without its row", () => {
    expect(viewParams("metrics", { ...focus, expand: null }, null, "30m").tile).toBeNull();
  });

  it("reads back as what it wrote", () => {
    for (const tab of ["metrics", "upstreams", "errors"]) {
      const p = viewParams(tab, { ...focus, range: { from: NOW - HOUR, to: NOW } }, null, "30m");
      const q = new URLSearchParams(Object.entries(p).filter((e): e is [string, string] => e[1] !== null));
      const back = focusFromSearch(`?${q}`, tab, NOW).focus;
      expect(viewParams(tab, back, null, "30m")).toEqual(p);
    }
  });
});

describe("sameFocus / hasFocus", () => {
  it("compares by value", () => {
    const a: ViewFocus = { ...NO_FOCUS, upstream: { name: "n", spec: "ETH1" }, range: { from: 1, to: 2 } };
    expect(sameFocus(a, { ...a, upstream: { name: "n", spec: "ETH1" }, range: { from: 1, to: 2 } })).toBe(true);
    expect(sameFocus(a, { ...a, range: { from: 1, to: 3 } })).toBe(false);
    expect(sameFocus(a, { ...a, upstream: { name: "n", spec: null } })).toBe(false);
    expect(sameFocus(NO_FOCUS, { ...NO_FOCUS })).toBe(true);
  });

  it("is something in focus", () => {
    expect(hasFocus(NO_FOCUS)).toBe(false);
    expect(hasFocus({ ...NO_FOCUS, expand: "eth-prod" })).toBe(true);
    expect(hasFocus({ ...NO_FOCUS, range: { from: 1, to: 2 } })).toBe(true);
  });
});

describe("notices", () => {
  it("says what the page shows instead", () => {
    expect(spanNotice("expired", "30 minutes")).toContain("The list shows the last 30 minutes.");
    expect(spanNotice("unreadable", "1 day")).toContain("can't be read");
    expect(spanNotice("clipped", "1 day")).toContain("starts 30 days ago");
    expect(windowNotice("2y", "30 minutes")).toBe(`The time window in this link, "2y", isn't one this page offers. Showing the last 30 minutes.`);
  });
});

describe("tokens", () => {
  it("are what a spec index and a router id look like", () => {
    expect(SPEC_TOKEN.test("ETH1")).toBe(true);
    expect(SPEC_TOKEN.test("ETH 1")).toBe(false);
    expect(ROUTER_TOKEN.test("eth-prod.v2")).toBe(true);
    expect(ROUTER_TOKEN.test("eth/prod")).toBe(false);
  });
});
