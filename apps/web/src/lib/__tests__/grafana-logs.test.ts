import { describe, expect, it } from "vitest";
import { logsBoardHref, requestLogsHref } from "../grafana-logs";

const BASE = "http://localhost:3001/";

describe("logsBoardHref", () => {
  it("opens the board on a live window and a search", () => {
    const href = new URL(logsBoardHref(BASE, { search: "ETH1", from: "now-3600s", to: "now", refresh: "5s" }));
    expect(href.origin + href.pathname).toBe("http://localhost:3001/");
    expect(Object.fromEntries(href.searchParams)).toEqual({
      orgId: "1", from: "now-3600s", to: "now", timezone: "browser", "var-service": "router", "var-search": "ETH1", refresh: "5s",
    });
  });
});

describe("requestLogsHref", () => {
  it("searches for the request's ID, from a minute before it started to a minute after it ended", () => {
    const q = new URL(requestLogsHref(BASE, "7043733", 1_760_000_000_000, 500)).searchParams;
    expect(q.get("var-search")).toBe("7043733");
    expect(q.get("from")).toBe(String(1_760_000_000_000 - 60_000));
    expect(q.get("to")).toBe(String(1_760_000_000_500 + 60_000));
    expect(q.has("refresh")).toBe(false); // a closed range doesn't poll
  });

  it("a request whose end isn't known: a minute either side of its start", () => {
    const q = new URL(requestLogsHref(BASE, "7043733", 1_000_000, null)).searchParams;
    expect([q.get("from"), q.get("to")]).toEqual(["940000", "1060000"]);
  });
});
