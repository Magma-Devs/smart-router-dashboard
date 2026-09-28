import { describe, it, expect, afterEach, vi } from "vitest";
import { alertText, criticalChanges, postAlerts } from "../services/issue-alerts.js";
import type { ServedIssue } from "../services/issues-feed.js";

const issue = (over: Partial<ServedIssue> = {}): ServedIssue =>
  ({
    id: "SOLANA:1",
    status: "open",
    severity: "critical",
    spec: "SOLANA",
    chain: "Solana",
    specs: ["SOLANA"],
    title: "Tatum times out, and every backup fails too",
    impact: "109 of 23,144 requests (0.47%) failed: no provider answered them.",
    whoActs: "Tatum (the provider) — it is not answering in time.",
    ...over,
  }) as ServedIssue;

describe("issue alerts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("tells someone when a chain turns Critical, and when that resolves — nothing else", () => {
    expect(criticalChanges([], [issue()]).map((e) => e.kind)).toEqual(["critical"]);
    // Already Critical last cycle: said once, not every five minutes.
    expect(criticalChanges([issue()], [issue()])).toEqual([]);
    // Moved up from Degraded.
    expect(criticalChanges([issue({ severity: "degraded" })], [issue()]).map((e) => e.kind)).toEqual(["critical"]);
    expect(criticalChanges([issue()], [issue({ status: "resolved" })]).map((e) => e.kind)).toEqual(["resolved"]);
    // Degraded is on the page, not in someone's pocket.
    expect(criticalChanges([], [issue({ severity: "degraded" })])).toEqual([]);
  });

  it("says what the card says, with the page's link", () => {
    expect(alertText({ kind: "critical", issue: issue() }, "https://dash.example/")).toBe(
      [
        "Critical — Solana: Tatum times out, and every backup fails too",
        "109 of 23,144 requests (0.47%) failed: no provider answered them.",
        "Who acts: Tatum (the provider) — it is not answering in time.",
        "https://dash.example/status",
      ].join("\n"),
    );
    expect(alertText({ kind: "resolved", issue: issue({ status: "resolved" }) })).toBe(
      "Resolved — Solana: Tatum times out, and every backup fails too",
    );
  });

  it("posts { text }, and never logs the url — it carries a secret", async () => {
    const posts: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      posts.push({ url, body: init.body });
      throw new Error("receiver down");
    });
    const warn = vi.fn();
    await postAlerts("https://hooks.example/T000/SECRET", [{ kind: "critical", issue: issue() }], { logger: { warn } });
    expect(JSON.parse(posts[0]!.body).text).toMatch(/^Critical — Solana/);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/SECRET|hooks\.example/);
  });
});
