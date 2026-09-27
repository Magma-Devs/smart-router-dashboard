import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plainIssue, type FormulatedInputs, type FormulatedIssue } from "../services/formulated-issues.js";
import type { MetricsDetailService } from "../services/metrics-detail.js";
import { LokiService } from "../services/loki.js";
import { IssueLog, IssuesFeedService, REOPEN_GRACE_SEC, type Sighting } from "../services/issues-feed.js";

const T0 = 1_790_000_000;

function issue(over: Partial<FormulatedIssue> = {}): FormulatedIssue {
  return {
    severity: "degraded",
    spec: "SOLANAT",
    chain: "Solana Testnet",
    title: "Blockdaemon is failing to answer",
    points: ["652 of 20,829 got no answer."],
    bottomLine: "Your chain mostly works.",
    ongoing: true,
    specs: ["SOLANAT"],
    findingIds: ["SOLANAT:blockdaemon:dead"],
    lastSeenUnix: null,
    outcome: { recovered: 653, failures: 652, requests: 20_829, addonCalls: [], writes: null, paths: null },
    impact: null,
    measured: null,
    ...over,
  };
}
const saw = (over: Partial<Sighting> = {}): Sighting => ({
  key: "SOLANAT",
  issue: issue(),
  print: "p1",
  firstSeenUnix: T0 - 600,
  ...over,
});

describe("IssueLog: one issue per problem, for its whole life", () => {
  it("opens an issue at the earliest failure the window shows", () => {
    const log = new IssueLog();
    log.advance([saw()], T0);
    const [i] = log.view(1800, T0);
    expect(i).toMatchObject({ status: "open", openedAtUnix: T0 - 600, id: `SOLANAT:${T0 - 600}` });
  });

  it("keeps the same id while it keeps failing, and updates it in place", () => {
    const log = new IssueLog();
    log.advance([saw()], T0);
    const later = issue({ points: ["1,538 of 21,163 got no answer."] });
    log.advance([saw({ issue: later, print: "p2" })], T0 + 300);
    const all = log.view(1800, T0 + 300);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: `SOLANAT:${T0 - 600}`, updatedAtUnix: T0 + 300, points: later.points });
  });

  it("records when the badge moved, on the same issue", () => {
    const log = new IssueLog();
    log.advance([saw()], T0);
    log.advance([saw({ issue: issue({ severity: "critical" }) })], T0 + 300);
    expect(log.view(1800, T0 + 300)[0]).toMatchObject({ severity: "critical", severitySinceUnix: T0 + 300 });
  });

  it("resolves at the last failure seen when a cycle no longer finds it", () => {
    const log = new IssueLog();
    log.advance([saw({ issue: issue({ lastSeenUnix: T0 - 60 }) })], T0);
    log.advance([], T0 + 300);
    expect(log.view(1800, T0 + 300)[0]).toMatchObject({ status: "resolved", resolvedAtUnix: T0 - 60, ongoing: false });
  });

  it("a problem back within the grace is the same issue, reopened", () => {
    const log = new IssueLog();
    log.advance([saw()], T0);
    log.advance([], T0 + 300);
    log.advance([saw()], T0 + 900);
    const all = log.view(3600, T0 + 900);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: `SOLANAT:${T0 - 600}`, status: "open", resolvedAtUnix: null });
  });

  it("back after the grace is a new issue; the old one stays in history", () => {
    const log = new IssueLog();
    log.advance([saw()], T0);
    log.advance([], T0 + REOPEN_GRACE_SEC + 60);
    const back = T0 + REOPEN_GRACE_SEC + 600;
    log.advance([saw({ firstSeenUnix: back - 120 })], back);
    const ids = log.view(86_400, back).map((i) => `${i.id}:${i.status}`);
    expect(ids).toEqual([`SOLANAT:${back - 120}:open`, `SOLANAT:${T0 - 600}:resolved`]);
  });

  it("the window is a filter: resolved before it started, it is not shown", () => {
    const log = new IssueLog();
    log.advance([saw({ issue: issue({ lastSeenUnix: T0 }) })], T0);
    log.advance([], T0 + 300);
    const sixHoursLater = T0 + 6 * 3600;
    expect(log.view(1800, sixHoursLater)).toHaveLength(0); // 30m: gone
    expect(log.view(6 * 3600, sixHoursLater)).toHaveLength(1); // 6h: still listed
  });
});

describe("IssuesFeedService: switching window reads the log", () => {
  it("answers any window straight from a saved log — no cycle, no model call", () => {
    const dir = mkdtempSync(join(tmpdir(), "issue-log-"));
    const file = join(dir, "issues.json");
    const log = new IssueLog();
    log.advance([saw()], T0);
    writeFileSync(
      file,
      JSON.stringify({ log, lastCycle: { computedAtUnix: T0, logsAvailable: true, configAvailable: true } }),
    );

    // `detail` is never touched: a view is a read of the log.
    const feed = new IssuesFeedService({} as MetricsDetailService, undefined, undefined, { stateFile: file });
    expect(feed.view("30m", T0 + 60)?.issues.map((i) => i.id)).toEqual([`SOLANAT:${T0 - 600}`]);
    expect(feed.view("6h", T0 + 60)?.issues).toHaveLength(1);
  });

  it("with no saved log and no cycle yet, there is nothing to show", () => {
    const feed = new IssuesFeedService({} as MetricsDetailService);
    expect(feed.view("30m")).toBeNull();
  });
});

describe("IssuesFeedService: an outage wider than the writing budget", () => {
  // The model writes at most `limit` issues a cycle. That cap used to cut
  // DETECTION at 20 chains, and an open issue a cycle does not find is
  // resolved — so past 20 failing chains, the page said "resolved" about
  // chains that were still down, at the worst moment of an outage.
  const chains = Array.from({ length: 25 }, (_, i) => `CH${String(i).padStart(2, "0")}`);
  const report = {
    computedAtUnix: T0,
    insights: [],
    findings: chains.map((spec) => ({
      kind: "dead",
      tier: "critical",
      id: `${spec}:tatum:errors`,
      spec,
      chainName: spec,
      upstream: "tatum",
      role: "primary",
      headline: "40% errors - mostly no reply",
      metric: { value: "40%", label: "of answers" },
      codes: [],
      evidence: [],
      remedy: "",
      sinceSec: null,
      firstSeenUnix: T0 - 600,
      lastSeenUnix: T0,
      ongoing: true,
      decision: [],
    })),
  };
  const feedWith = (writer: { formulate: (i: FormulatedInputs) => Promise<FormulatedIssue> }) =>
    new IssuesFeedService({ status: async () => report } as unknown as MetricsDetailService, undefined, undefined, {
      writer,
      loki: new LokiService(undefined),
    });

  it("keeps every failing chain on the page, and writes the rest on the next cycle", async () => {
    const written: string[] = [];
    const feed = feedWith({
      formulate: async (inputs) => {
        written.push(inputs.spec);
        return { ...plainIssue(inputs), title: "written", plain: undefined };
      },
    });

    await feed.refresh(20);
    let issues = feed.view("30m", T0 + 60)!.issues;
    expect(written).toHaveLength(20);
    expect(issues).toHaveLength(25);
    expect(issues.every((i) => i.status === "open")).toBe(true);
    // The five past the budget are on the page, from their numbers.
    expect(issues.filter((i) => i.plain)).toHaveLength(5);

    await feed.refresh(20);
    issues = feed.view("30m", T0 + 60)!.issues;
    expect(written).toHaveLength(25); // only the five not yet written
    expect(issues.filter((i) => i.plain)).toHaveLength(0);
    expect(issues.every((i) => i.status === "open")).toBe(true);
  });

  it("a new issue whose words fail is still shown, written from its numbers", async () => {
    const feed = feedWith({
      formulate: async () => {
        throw new Error("the model is unreachable");
      },
    });
    await feed.refresh(20);
    const issues = feed.view("30m", T0 + 60)!.issues;
    expect(issues).toHaveLength(25);
    expect(issues.every((i) => i.plain && i.status === "open")).toBe(true);
  });
});

describe("IssuesFeedService: a rules change rewrites from scratch", () => {
  const finding = (headline: string) => ({
    kind: "dead",
    tier: "critical",
    id: "SOLANA:tatum:errors",
    spec: "SOLANA",
    chainName: "Solana",
    upstream: "tatum",
    role: "primary",
    headline,
    metric: { value: "40%", label: "of answers" },
    codes: [],
    evidence: [],
    remedy: "",
    sinceSec: null,
    firstSeenUnix: T0 - 600,
    lastSeenUnix: T0,
    ongoing: true,
    decision: [],
  });

  function run(saved: { print: string } | null) {
    const dir = mkdtempSync(join(tmpdir(), "issue-rules-"));
    const file = join(dir, "issues.json");
    if (saved) {
      const log = new IssueLog();
      log.advance([saw({ key: "SOLANA", print: saved.print, issue: issue({ spec: "SOLANA", title: "on screen" }) })], T0);
      writeFileSync(file, JSON.stringify({ log, lastCycle: { computedAtUnix: T0, logsAvailable: false, configAvailable: false } }));
    }
    const previous: (string | undefined)[] = [];
    const feed = new IssuesFeedService(
      { status: async () => ({ computedAtUnix: T0, insights: [], findings: [finding("41% errors - mostly no reply")] }) } as unknown as MetricsDetailService,
      undefined,
      undefined,
      {
        stateFile: file,
        loki: new LokiService(undefined),
        writer: {
          formulate: async (inputs) => {
            previous.push(inputs.previous?.title);
            return plainIssue(inputs);
          },
        },
      },
    );
    return { feed, previous };
  }

  it("words written under the old rules are not updated — they are replaced", async () => {
    // A v2 card said "causing some requests to fail" over a line saying every
    // request got a reply, and kept saying it: an update keeps its title.
    const { feed, previous } = run({ print: "v2~SOLANA:tatum:errors|critical|40% errors" });
    await feed.refresh();
    expect(previous).toEqual([undefined]);
  });

  it("words written under these rules are updated in place", async () => {
    const { feed, previous } = run({ print: "v3~SOLANA:tatum:errors|critical|40% errors" });
    await feed.refresh();
    expect(previous).toEqual(["on screen"]);
  });
});
