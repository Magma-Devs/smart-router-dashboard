"use client";

/**
 * The Issues tab: one written issue per affected chain, in severity sections.
 *
 * This REPLACES the metric rows. A row saying "38.9% errors · line 5% · was
 * 0.13% this time last week" is the measurement, and the measurement is not
 * the thing the reader wants — they want the gist: what is happening, simply
 * put, and why. The numbers are still there, on the finding rows the issue
 * cites, one disclosure away.
 *
 * Short numbered facts and a bottom line, copied from how this team already
 * writes these in Slack. The points walk the chain — what is failing, why,
 * what the router did, and why the failover did or did not save it — but they
 * are ONE fact per line, not four labelled paragraphs. The paragraph version
 * read as an essay, which is the thing a bottom line exists to avoid.
 *
 * EVERYTHING ON THE CARD IS ON SCREEN. There is no "view more": a disclosure
 * is a card admitting it wrote more than it should have and then charging the
 * reader a click for the rest — and what sat behind it was as often the cause
 * as the padding. So the cap moved upstream instead. The model writes two to
 * four facts under fourteen words, is told not to repeat the title, and is
 * told not to restate a point in the bottom line. A card is four short lines,
 * read in about five seconds, and the measurements stay one level down on the
 * findings it cites.
 *
 * Four sections, each with its meaning on screen: Critical, Degraded,
 * Handled by the router, Refused by the chain — then Risks, where nothing is
 * failing yet. The toggle is a secondary ORDER — Recent, which answers "what
 * just started", or by chain.
 *
 * There is no analyse button. The api keeps an issue log, updated on a loop,
 * and the page reads it — so changing the time window is a filter over that
 * log and returns instantly. Each problem is ONE issue for as long as it
 * lasts: same card, same id, numbers updated in place, then resolved.
 */
import { useEffect, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { useFilters } from "@/components/gateway/FiltersProvider";

interface Issue {
  severity: "critical" | "degraded" | "config";
  spec: string;
  chain: string;
  title: string;
  points: string[];
  bottomLine: string;
  findingIds: string[];
  ongoing?: boolean;
  specs?: string[];
  /** Newest activity across the findings behind it. Drives the by-time order. */
  lastSeenUnix?: number | null;
  /** The same for as long as the problem keeps failing — the card's identity. */
  id: string;
  status: "open" | "resolved";
  openedAtUnix: number;
  updatedAtUnix: number;
  resolvedAtUnix: number | null;
  severitySinceUnix: number;
  /** Measured, not written. Only what the card shows is read here. */
  outcome?: {
    failures: number | null;
    paths: FailurePaths | null;
    rejected?: { latest: RequestRef[] } | null;
  };
  /** The chain's numbers in one line, written by the api from the measurements. */
  impact?: string | null;
  /** The time those numbers cover. */
  measured?: { fromUnix: number; toUnix: number } | null;
  /** Written from the measurements alone; the model writes it next cycle. */
  plain?: boolean;
  /** A provider is failing and the router covered every request. */
  handled?: boolean;
  /** Who can act on it — written by the api, never by the model. */
  whoActs?: string | null;
  /** Error names a caller's own log would show. */
  codes?: string[];
  /** Several chains failing at once. */
  together?: boolean;
  /** One point per five-minute check, oldest first. */
  timeline?: TimelinePoint[];
}

interface RequestRef {
  id: string;
  atUnix: number;
}

interface TimelinePoint {
  t: number;
  failed: number | null;
  saved: number | null;
  refused: number | null;
}

/** A chain that works now and has nothing to fall back on. */
interface Risk {
  spec: string;
  chain: string;
  text: string;
  calls: number | null;
  unit: string;
}

/** Every traced request that went one way through the router. */
interface FailurePath {
  count: number;
  flow: string;
  /** The path without its times — stable across cycles, so the row's key. */
  route?: string;
  methods: string[];
  seconds: [number, number];
  ids?: RequestRef[];
  errors?: string[];
}
interface FailurePaths {
  traced: number;
  groups: FailurePath[];
}

interface Answer {
  ok: true;
  issues: Issue[];
  risks?: Risk[];
  logsAvailable: boolean;
  configAvailable: boolean;
}
interface Refusal {
  ok: false;
  reason: string;
  detail?: string;
}

/**
 * Four sections, each with what it means on screen — a badge word nobody
 * explained was read as whatever the reader guessed. Only the first two have
 * colour: amber on a chain the router is fully covering, every day, teaches
 * people to ignore amber.
 */
const SECTIONS = [
  { key: "critical", label: "Critical", meaning: "The chain can't be used.", color: "var(--err, #ef4444)" },
  {
    key: "degraded",
    label: "Degraded",
    meaning: "The chain works, but some requests failed, got errors or waited.",
    color: "var(--warn, #f59e0b)",
  },
  {
    key: "handled",
    label: "Handled by the router",
    meaning: "A provider is failing, and the router covered every request.",
    color: "var(--text-3, #64748b)",
  },
  {
    key: "config",
    label: "Refused by the chain",
    meaning: "The chain refused the requests themselves. No provider failed.",
    color: "var(--text-3, #64748b)",
  },
] as const;

const sectionOf = (i: Issue): (typeof SECTIONS)[number]["key"] =>
  i.severity === "degraded" && i.handled ? "handled" : i.severity;

/** Opened within the last hour: what just started, as opposed to what has been there all week. */
const NEW_SEC = 3600;

const RESOLVED_COLOR = "var(--text-4, #94a3b8)";

/** 14:05 today, "Sep 26 14:05" otherwise — an issue can outlive a day. */
function clock(unix: number): string {
  const d = new Date(unix * 1000);
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toDateString() === new Date().toDateString()
    ? t
    : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${t}`;
}

/**
 * The issue's life in one short line. Open: when it started, and when the
 * badge last moved if it has. Resolved: start to end. This is what makes a
 * card read as one problem being followed, not a new card every refresh.
 */
function lifeLine(i: Issue, now: number): string {
  if (i.status === "resolved" && i.resolvedAtUnix != null) {
    return `${clock(i.openedAtUnix)}–${clock(i.resolvedAtUnix)}`;
  }
  const moved = i.severitySinceUnix > i.openedAtUnix + 60;
  // Past a day, the age is the news: "since Sep 24 14:48" makes the reader
  // count; "3 days" does not.
  const days = Math.floor((now - i.openedAtUnix) / 86_400);
  return `since ${clock(i.openedAtUnix)}${days >= 1 ? ` (${days} ${days === 1 ? "day" : "days"})` : ""}${
    moved ? ` · ${i.severity} since ${clock(i.severitySinceUnix)}` : ""
  }`;
}

/** 23:21:05 — the precision a caller's log line has. */
function clockSec(unix: number): string {
  return new Date(unix * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function specLabel(specs: string[]): string {
  return specs.length <= 3 ? specs.join(" · ") : `${specs.slice(0, 3).join(" · ")} +${specs.length - 3}`;
}

/** The paths a card lists; the rest are summed into one line under them. */
const MAX_PATHS = 3;

function methodsLabel(m: string[]): string {
  return m.length <= 2 ? m.join(", ") : `${m.slice(0, 2).join(", ")} +${m.length - 2}`;
}

/** `failed` → `failed at 30s`, or `at 28–30s` when the requests differed — the same clock as the "+7s" steps. */
function flowLine(g: FailurePath): string {
  const [lo, hi] = g.seconds.map(Math.round) as [number, number];
  return `${g.flow} at ${lo === hi ? lo : `${lo}–${hi}`}s`;
}

/**
 * The chain's numbers, with the time they cover. Written by the api from the
 * measurements — never by the model — in words that mean one thing each.
 *
 * The time is the point. The page's window picks WHICH issues show; the
 * numbers are always the last half hour the api read. Without the time, a
 * reader who chose "6 hours" read 30-minute counts as six hours of them.
 * Resolved issues show the half hour they were last seen in.
 */
function Impact({ issue }: { issue: Issue }) {
  if (!issue.impact) return null;
  const m = issue.measured;
  const range = m ? `${clock(m.fromUnix)}–${clock(m.toUnix)}` : null;
  const when = !m
    ? null
    : issue.status === "resolved" || issue.together
      ? range
      : `Last ${Math.round((m.toUnix - m.fromUnix) / 60)} min (${range})`;
  return (
    <div style={{ fontSize: 12.5, lineHeight: 1.5, margin: "0 0 8px", color: "var(--text)" }}>
      {when && <span style={{ color: "var(--text-3)" }}>{when}: </span>}
      {issue.impact}
    </div>
  );
}

/**
 * How the failed requests went, one plain line per path: the provider each
 * tried, the backup it moved to, how each attempt ended. It answers "was that
 * the same request?" — "alchemy timed out on 3, quicknode on 2" cannot, and
 * this is the router's own log, not the model's reading of it.
 */
function Paths({ paths, failures }: { paths: FailurePaths; failures: number | null }) {
  const shown = paths.groups.slice(0, MAX_PATHS);
  const rest = paths.groups.slice(MAX_PATHS);
  const restCount = rest.reduce((a, g) => a + g.count, 0);
  return (
    <div style={{ marginTop: 9 }}>
      <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 3 }}>
        What happened to the failed requests
        {failures != null && failures > paths.traced ? ` · ${paths.traced} of ${failures} traced` : ""}
        {/* "+8s" is the one piece of notation on the card, so it is
            explained where it is read — with a number that is actually on
            screen, not an example the reader has to look for. */}
        {(() => {
          const n = shown.map((g) => /\+(\d+)s /.exec(g.flow)?.[1]).find(Boolean);
          return n ? ` · +${n}s = ${n} seconds after the request arrived` : "";
        })()}
      </div>
      {shown.map((g) => (
        <div key={g.route ?? g.flow} className="gw-mono" style={{ fontSize: 11, lineHeight: 1.55, color: "var(--text-2)" }}>
          <span style={{ color: "var(--text)" }}>{g.count}×</span> {methodsLabel(g.methods)}
          <span style={{ color: "var(--text-3)" }}> · </span>
          {flowLine(g)}
        </div>
      ))}
      {restCount > 0 && (
        <div className="gw-mono" style={{ fontSize: 11, lineHeight: 1.55, color: "var(--text-3)" }}>
          {restCount}× on {rest.length} other {rest.length === 1 ? "path" : "paths"}
        </div>
      )}
    </div>
  );
}

/**
 * The issue's life as bars, one per five-minute check: is it getting worse
 * or better? The number each bar is depends on the card — failures, or what
 * the router saved on a card where nothing failed, or what the chain refused.
 * Grey, not the tier colour: one colour per card, carried by its border.
 */
function Timeline({ issue }: { issue: Issue }) {
  const points = issue.timeline ?? [];
  if (points.length < 2) return null;
  const pick = (p: TimelinePoint) =>
    issue.severity === "config" ? p.refused : issue.handled ? p.saved : p.failed;
  const label = issue.severity === "config" ? "refused" : issue.handled ? "saved by the router" : "failed";
  const shown = points.slice(-72);
  // A row of empty bars under "requests failed" on a card about error
  // replies says nothing, and reads as a chart that did not load.
  if (shown.every((p) => !pick(p))) return null;
  const top = Math.max(1, ...shown.map((p) => pick(p) ?? 0));
  const W = 3;
  const H = 18;
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 7, margin: "0 0 8px" }}>
      <svg width={shown.length * W} height={H} role="img" aria-label={`Requests ${label} at each check`}>
        {shown.map((p, i) => {
          const v = pick(p);
          const h = v == null ? 1 : Math.max(1, Math.round((v / top) * H));
          return (
            <rect key={p.t} x={i * W} y={H - h} width={W - 1} height={h} fill={i === shown.length - 1 ? "var(--text-2)" : "var(--text-4)"}>
              <title>{`${clock(p.t)} · ${v == null ? "not measured" : `${v.toLocaleString("en-US")} ${label}`}`}</title>
            </rect>
          );
        })}
      </svg>
      <span style={{ fontSize: 10.5, color: "var(--text-3)" }}>
        Requests {label}, one bar per 5-minute check since {clock(shown[0]!.t)}
      </span>
    </div>
  );
}

/**
 * The strings a caller's own log has, so support can match a complaint to
 * this card: the newest request ids with their second, and the router's
 * error names. Selectable text, in the log's own format.
 */
function Evidence({ issue }: { issue: Issue }) {
  const fromPaths = (issue.outcome?.paths?.groups ?? []).flatMap((g) => g.ids ?? []);
  const ids = (fromPaths.length > 0 ? fromPaths : (issue.outcome?.rejected?.latest ?? []))
    .sort((a, b) => b.atUnix - a.atUnix)
    .slice(0, 3);
  const codes = issue.codes ?? [];
  if (ids.length === 0 && codes.length === 0) return null;
  return (
    <div className="gw-mono" style={{ fontSize: 10.5, color: "var(--text-3)", marginTop: 7, lineHeight: 1.55, userSelect: "text" }}>
      {ids.length > 0 && <div>Request IDs (newest): {ids.map((r) => `${r.id} at ${clockSec(r.atUnix)}`).join(", ")}</div>}
      {codes.length > 0 && <div>Error codes: {codes.join(", ")}</div>}
    </div>
  );
}

/** Nothing is failing on these — one provider stands between them and failing. */
function Risks({ risks }: { risks: Risk[] }) {
  if (risks.length === 0) return null;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 7, flexWrap: "wrap" }}>
        <span style={{ width: 7, height: 7, borderRadius: 99, border: "1px solid var(--text-3)", alignSelf: "center" }} />
        <span style={{ fontSize: 12, fontWeight: 700 }}>Risks</span>
        <span style={{ fontSize: 11, color: "var(--text-4)" }}>{risks.length}</span>
        <span style={{ fontSize: 11, color: "var(--text-3)" }}>Nothing is failing now. One provider stands between these and failing.</span>
      </div>
      {risks.map((r) => (
        <div key={`${r.spec}:${r.text}`} className="gw-card" style={{ padding: "9px 14px", marginBottom: 6, display: "flex", alignItems: "center", gap: 9 }}>
          <ChainBadge spec={r.spec} size={18} />
          <span style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.5 }}>
            {r.text}
            {r.calls != null && (
              <span style={{ color: "var(--text-3)" }}>
                {" "}
                ({r.calls.toLocaleString("en-US")} {r.unit} in the last 30 min)
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function refusalText(r: Refusal): string {
  if (r.reason === "disabled") return "AI is not enabled on this deployment.";
  if (r.reason === "auth_required") return "AI needs sign-in on this deployment.";
  return `Could not reach the model. ${r.detail ?? ""}`.trim();
}

/** `now` is unix seconds from the list's own clock — a render must not read the time itself. */
function Card({ issue, color, now }: { issue: Issue; color: string; now: number }) {
  const resolved = issue.status === "resolved";
  // No disclosure. A "View more · 2 more" is the card admitting it wrote more
  // than it should have and then making the reader work for the rest — and
  // the hidden points were as often the cause as the padding. The fix is
  // upstream: the model writes two to four short facts, and all of them are
  // on screen.
  return (
    <div
      className="gw-card"
      style={{
        borderLeft: `3px solid ${color}`,
        marginBottom: 8,
        padding: "12px 14px",
        position: "relative",
        // Kept on the page for the window it was active in, but quieter than
        // anything still happening.
        opacity: resolved ? 0.6 : 1,
      }}
    >
      {issue.ongoing && (
        // A bookmark down the right edge rather than a chip in the header: it
        // is the one property you scan a list for, and scanning one column
        // beats reading every title.
        <span
          style={{
            position: "absolute",
            top: 0,
            right: 14,
            padding: "3px 7px 5px",
            background: color,
            color: "#fff",
            fontSize: 8.5,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            borderRadius: "0 0 3px 3px",
          }}
        >
          Ongoing
        </span>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        {/* The chain's own mark, the same one every other surface uses. */}
        <ChainBadge spec={issue.spec} size={22} />
        <span style={{ fontSize: 13, fontWeight: 700 }}>
          {/* A merged issue names every chain it covers, or the card claims to
              be about one chain while its points name four. */}
          {(issue.specs?.length ?? 1) > 1 ? `${issue.specs!.length} chains` : issue.chain}
        </span>
        {issue.status === "open" && now - issue.openedAtUnix < NEW_SEC && (
          // What just started, apart from what has been there all week.
          <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.04em", color: "var(--text-2)", border: "1px solid var(--line-2, #333)", borderRadius: 4, padding: "0 5px" }}>
            NEW
          </span>
        )}
        {/* The spec index is what appears in their own logs and queries, so
            it stays — but a merged issue printing twelve of them is a line of
            noise above the sentence that matters. */}
        <span className="gw-mono" style={{ fontSize: 9.5, color: "var(--text-4)" }}>
          {specLabel(issue.specs ?? [issue.spec])} · {lifeLine(issue, now)}
        </span>
      </div>

      <div style={{ fontSize: 13, fontWeight: 600, margin: "7px 0 8px" }}>{issue.title}</div>

      <Impact issue={issue} />
      <Timeline issue={issue} />

      <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 3 }}>
        {issue.points.map((p, i) => (
          <li key={i} style={{ fontSize: 12.5, lineHeight: 1.5, color: "var(--text-2)" }}>
            {p}
          </li>
        ))}
      </ol>

      {issue.plain && (
        // Said, not hidden: a card in the findings' own shorthand next to
        // written ones would otherwise read as a worse writer.
        <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 6 }}>
          From the measurements only — the written summary comes with the next update.
        </div>
      )}

      {issue.outcome?.paths && issue.outcome.paths.groups.length > 0 && (
        <Paths paths={issue.outcome.paths} failures={issue.outcome.failures} />
      )}
      <Evidence issue={issue} />

      {issue.bottomLine && (
        <div
          style={{
            fontSize: 12.5,
            lineHeight: 1.5,
            marginTop: 9,
            paddingTop: 8,
            borderTop: "1px solid var(--border, #222)",
            color: "var(--text)",
          }}
        >
          <span style={{ fontWeight: 700, color }}>Bottom line: </span>
          {issue.bottomLine}
        </div>
      )}

      {issue.whoActs && (
        <div style={{ fontSize: 12, lineHeight: 1.5, marginTop: issue.bottomLine ? 5 : 9, color: "var(--text-2)" }}>
          <span style={{ fontWeight: 600, color: "var(--text)" }}>Who acts: </span>
          {issue.whoActs}
        </div>
      )}
    </div>
  );
}

/** `chainsAffected` is null until the status report has loaded — not "none". */
export function IssueCards({ chainsAffected }: { chainsAffected: string[] | null }) {
  const { timeWindow, scopeQ } = useFilters();
  // Recent first by default: opening the page, the question is what just
  // started, not which chain sorts first alphabetically.
  const [order, setOrder] = useState<"recent" | "chain">("recent");
  // "New" and "3 days" age with the page left open: a minute is enough.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(t);
  }, []);

  // Polled, not pressed. `warming` comes back while a window is still being
  // computed, so the poll keeps asking until it lands.
  const { data } = useApi<Answer | Refusal>(`/api/ai/issues?window=${timeWindow}${scopeQ}`);
  const issues = data?.ok ? data.issues : null;
  const refusal = data && !data.ok ? data : null;
  const warming = refusal?.reason === "warming";

  const sorted = (list: Issue[]): Issue[] =>
    [...list].sort(
      (a, b) =>
        // Several chains failing at once leads its section: it explains the
        // per-chain cards under it.
        Number(!!b.together) - Number(!!a.together) ||
        (order === "recent"
          ? (b.lastSeenUnix ?? b.updatedAtUnix) - (a.lastSeenUnix ?? a.updatedAtUnix)
          : a.chain.localeCompare(b.chain)),
    );
  const open = issues?.filter((i) => i.status !== "resolved") ?? [];
  const resolved = (issues ?? [])
    .filter((i) => i.status === "resolved")
    .sort((a, b) => (b.resolvedAtUnix ?? 0) - (a.resolvedAtUnix ?? 0));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {(["recent", "chain"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setOrder(k)}
            style={{
              fontSize: 11,
              padding: "3px 10px",
              borderRadius: 4,
              cursor: "pointer",
              background: order === k ? "var(--brand)" : "transparent",
              color: order === k ? "#fff" : "var(--text-3)",
              border: `1px solid ${order === k ? "var(--brand)" : "var(--border, #333)"}`,
            }}
          >
            {k === "recent" ? "Recent" : "By chain"}
          </button>
        ))}
      </div>

      {/* Naming the chains it is working through is the difference between
          "loading" and "stuck" — and it is a wait nobody asked for, so it
          should at least say what it is doing. */}
      {warming && (
        // Skeletons, not a sentence. Changing the window recomputes and that
        // takes a minute; an unchanged page with one grey line on it reads as
        // broken, while a card-shaped placeholder reads as "coming".
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, color: "var(--text-3)", display: "flex", alignItems: "center", gap: 7 }}>
            <span className="gw-live-dot gw-live-dot--busy" />
            {/* Before the report lands the count is unknown, and "for 0 chains"
                read as "nothing to do" while the page was still working. */}
            {chainsAffected?.length ? (
              <>
                Reading errors and config for {chainsAffected.length}{" "}
                {chainsAffected.length === 1 ? "chain" : "chains"} — {chainsAffected.slice(0, 4).join(", ")}
                {chainsAffected.length > 4 ? "…" : ""}
              </>
            ) : (
              "Reading errors and config…"
            )}
          </div>
          {Array.from({ length: Math.min(Math.max(chainsAffected?.length ?? 0, 1), 3) }).map((_, i) => (
            <div key={i} className="gw-card" style={{ padding: "12px 14px", opacity: 0.45 }}>
              <div style={{ height: 11, width: "34%", background: "var(--text-4)", borderRadius: 3, opacity: 0.25 }} />
              <div style={{ height: 9, width: "72%", background: "var(--text-4)", borderRadius: 3, opacity: 0.18, marginTop: 9 }} />
              <div style={{ height: 9, width: "58%", background: "var(--text-4)", borderRadius: 3, opacity: 0.18, marginTop: 6 }} />
            </div>
          ))}
        </div>
      )}

      {refusal && !warming && (
        <div style={{ fontSize: 12, color: "var(--text-3)" }}>{refusalText(refusal)}</div>
      )}

      {issues && issues.length === 0 && (
        // Not "all clear" — the page never says that. No rule crossed.
        <div style={{ fontSize: 12, color: "var(--text-3)" }}>
          No chain crossed a rule in this window.
        </div>
      )}

      {issues &&
        SECTIONS.map(({ key, label, meaning, color }) => {
          const rows = sorted(open.filter((i) => sectionOf(i) === key));
          // An empty section is wallpaper — the page's own rule.
          if (rows.length === 0) return null;
          return (
            <div key={key}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 7, flexWrap: "wrap" }}>
                <span style={{ width: 7, height: 7, borderRadius: 99, background: color, alignSelf: "center" }} />
                <span style={{ fontSize: 12, fontWeight: 700 }}>{label}</span>
                <span style={{ fontSize: 11, color: "var(--text-4)" }}>{rows.length}</span>
                <span style={{ fontSize: 11, color: "var(--text-3)" }}>{meaning}</span>
              </div>
              {rows.map((i) => (
                <Card key={i.id} issue={i} color={color} now={now} />
              ))}
            </div>
          );
        })}

      {data?.ok && <Risks risks={data.risks ?? []} />}

      {resolved.length > 0 && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
            <span style={{ width: 7, height: 7, borderRadius: 99, background: RESOLVED_COLOR }} />
            <span style={{ fontSize: 12, fontWeight: 700 }}>Resolved</span>
            <span style={{ fontSize: 11, color: "var(--text-4)" }}>{resolved.length}</span>
          </div>
          {resolved.map((i) => (
            <Card key={i.id} issue={i} color={RESOLVED_COLOR} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}
