"use client";

import { useState } from "react";
import type { RelayTrace, TraceSeverity } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { ApiError } from "@/lib/api-client";
import { TraceSearch } from "./TraceSearch";

/** Severity → the existing tag vocabulary. Nothing here invents its own. */
const SEVERITY_TAG: Record<TraceSeverity, string> = {
  info: "gw-tag gw-tag--info",
  warning: "gw-tag gw-tag--warn",
  critical: "gw-tag gw-tag--err",
};

function clock(tMs: number): string {
  return new Date(tMs).toLocaleTimeString(undefined, { hour12: false }) + "." +
    String(tMs % 1000).padStart(3, "0");
}

/** Level → colour. Log levels are the router's own vocabulary, not
 *  `HealthState`, so they get their own colours but reuse the same tokens. */
const LEVEL_COLOR: Record<string, string> = {
  error: "var(--err)",
  warn: "var(--warn)",
  debug: "var(--text-3)",
  info: "var(--info)",
  trace: "var(--text-4)",
};

/**
 * Split one raw line into a headline and its remaining fields, FOR DISPLAY.
 *
 * This is presentation only — `trace-explain.ts` still sends the model the raw
 * line verbatim, so the "no log parser" contract in docs/trace-ai-page is
 * untouched. What it drops is pure duplication: `GUID` is the value you
 * searched for and repeats on every line, `time` is already in the gutter, and
 * `level` is rendered as a tag. Together that is roughly a third of every line.
 */
function present(line: string): { message: string; rest: string; raw: boolean } {
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    if (typeof o !== "object" || o === null) return { message: line, rest: "", raw: true };
    const message = typeof o.message === "string" ? o.message : "";
    const rest = Object.entries(o)
      .filter(([k]) => k !== "message" && k !== "GUID" && k !== "time" && k !== "level")
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join("  ");
    if (message === "" && rest === "") return { message: line, rest: "", raw: true };
    return { message: message || "(no message)", rest, raw: false };
  } catch {
    // Not JSON — the router's first bootstrap lines aren't. Show it as it came.
    return { message: line, rest: "", raw: true };
  }
}

/** Why there's no explanation, said plainly. Each of these is a different
 *  fact and the page should never blur them into "no answer". */
function skipMessage(trace: RelayTrace): string | null {
  switch (trace.explainSkipped) {
    case "disabled":
      return "The AI explanation is turned off on this deployment (TRACE_AI_ENABLED). The relay's log lines are below.";
    case "no_lines":
      return "No log lines carry this GUID in the window we searched. That could mean the relay is older than the log retention, the GUID is from a different router, or it was never relayed.";
    case "failed":
      return `The explanation could not be generated: ${trace.explainError ?? "unknown error"}. The log lines are below and are unaffected.`;
    default:
      return null;
  }
}

export function TraceView({ guid }: { guid: string }) {
  // No polling: a trace is a fixed historical fact, and each refetch would
  // spend another model call.
  const { data: trace, error, isLoading } = useApi<RelayTrace>(`/api/trace/${guid}`, 0);
  /** null = follow the default. With no explanation the lines are the ONLY
   *  content, so the page shouldn't open on a collapsed count of them. */
  const [showLinesPref, setShowLinesPref] = useState<boolean | null>(null);
  const [errorsOnly, setErrorsOnly] = useState(false);

  const noExplanation = trace !== undefined && trace.explanation === null;
  const showLines = showLinesPref ?? noExplanation;
  const errorCount = trace?.lines.filter((l) => l.level === "error").length ?? 0;
  const visibleLines = (trace?.lines ?? []).filter((l) => !errorsOnly || l.level === "error");

  return (
    <div className="gw-page">
      <div style={{ marginBottom: 20, maxWidth: 620 }}>
        <TraceSearch initial={guid} />
      </div>

      {isLoading && (
        <div className="gw-card">
          <div className="gw-skel" style={{ height: 18, width: "40%", marginBottom: 10 }} />
          <div className="gw-skel" style={{ height: 12, width: "90%", marginBottom: 6 }} />
          <div className="gw-skel" style={{ height: 12, width: "75%" }} />
        </div>
      )}

      {error !== undefined && (
        <div className="gw-card">
          <div className="gw-label" style={{ marginBottom: 6 }}>Could not load this trace</div>
          <div style={{ color: "var(--text-2)", fontSize: 13 }}>
            {error instanceof ApiError ? error.message : "The dashboard API did not answer."}
          </div>
        </div>
      )}

      {trace !== undefined && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--gap-card)" }}>
          {/* ---- The answer ---- */}
          {trace.explanation !== null ? (
            <div className="gw-card gw-card--accent">
              <div className="gw-label" style={{ marginBottom: 8 }}>What happened</div>
              <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>{trace.explanation.summary}</p>
            </div>
          ) : (
            /* Reason as a quiet footnote, not a heading. The lines below are
               the content in this state; the page shouldn't lead by announcing
               what is missing. */
            <div style={{ fontSize: 12.5, color: "var(--text-3)", padding: "0 2px" }}>
              {skipMessage(trace)}
            </div>
          )}

          {/* ---- Timeline ---- */}
          {trace.explanation !== null && trace.explanation.timeline.length > 0 && (
            <div className="gw-card">
              <div className="gw-label" style={{ marginBottom: 12 }}>Timeline</div>
              <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 10 }}>
                {trace.explanation.timeline.map((step, i) => (
                  <li key={i} style={{ display: "grid", gridTemplateColumns: "88px 1fr", gap: 12, alignItems: "baseline" }}>
                    <span className="gw-mono gw-tnum" style={{ fontSize: 11.5, color: "var(--text-3)" }}>{step.at}</span>
                    <span style={{ fontSize: 13.5 }}>{step.what}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* ---- Findings ---- */}
          {trace.explanation !== null && trace.explanation.findings.length > 0 && (
            <div className="gw-card">
              <div className="gw-label" style={{ marginBottom: 12 }}>Findings</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {trace.explanation.findings.map((f, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <span className={SEVERITY_TAG[f.severity]} style={{ flexShrink: 0 }}>{f.severity}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>{f.title}</div>
                      <div style={{ color: "var(--text-2)", fontSize: 13 }}>{f.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ---- The gaps. Deliberately given the same weight as the answer:
                  what the router failed to record is the most actionable thing
                  on this page. ---- */}
          {trace.explanation !== null && (
            <div className="gw-card">
              <div className="gw-label" style={{ marginBottom: 8 }}>What the logs don&rsquo;t say</div>
              {trace.explanation.notDetermined.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-2)", fontSize: 13 }}>
                  {trace.explanation.notDetermined.map((n, i) => (
                    <li key={i} style={{ marginBottom: 4 }}>{n}</li>
                  ))}
                </ul>
              ) : (
                <p style={{ margin: 0, color: "var(--text-3)", fontSize: 13 }}>
                  Nothing flagged. Treat that as the model&rsquo;s judgement, not a guarantee — check the lines below.
                </p>
              )}
            </div>
          )}

          {/* ---- The evidence ---- */}
          <div className="gw-card">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div className="gw-label">
                {/* With no explanation these lines ARE the page, so they get a
                    title that says what they are rather than a bare count. */}
                {noExplanation ? "Log lines for this relay" : "Log lines"} ({trace.lines.length}
                {trace.truncated ? ", truncated" : ""})
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {errorCount > 0 && showLines && (
                  <button
                    className="gw-btn gw-btn--ghost"
                    onClick={() => setErrorsOnly((e) => !e)}
                    style={{ fontSize: 12, color: errorsOnly ? "var(--err)" : undefined }}
                  >
                    {errorsOnly ? "All lines" : `Errors only (${errorCount})`}
                  </button>
                )}
                <button className="gw-btn gw-btn--ghost" onClick={() => setShowLinesPref(!showLines)} style={{ fontSize: 12 }}>
                  {showLines ? "Hide" : "Show"}
                </button>
              </div>
            </div>

            {trace.truncated && (
              <div style={{ fontSize: 12, color: "var(--warn)", marginTop: 8 }}>
                This relay logged more lines than we send to the model. You are seeing the beginning of the trail.
              </div>
            )}

            {showLines && (
              <div
                className="gw-mono"
                style={{
                  marginTop: 12, maxHeight: 460, overflow: "auto",
                  background: "var(--bg-2)", border: "1px solid var(--line)",
                  borderRadius: 8, padding: 12, fontSize: 11.5, lineHeight: 1.65,
                }}
              >
                {visibleLines.length === 0 ? (
                  <span style={{ color: "var(--text-3)" }}>
                    {trace.lines.length === 0 ? "No lines." : "No error lines in this trace."}
                  </span>
                ) : (
                  visibleLines.map((l, i) => {
                    const p = present(l.line);
                    const lvl = l.level ?? "";
                    return (
                      <div
                        key={i}
                        style={{
                          display: "grid", gridTemplateColumns: "84px 44px 1fr", gap: 10,
                          padding: "2px 0", alignItems: "baseline",
                        }}
                      >
                        <span className="gw-tnum" style={{ color: "var(--text-4)" }}>{clock(l.tMs)}</span>
                        <span style={{ color: LEVEL_COLOR[lvl] ?? "var(--text-4)", fontSize: 10, textTransform: "uppercase" }}>
                          {lvl}
                        </span>
                        <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                          <span style={{ color: lvl === "error" ? "var(--err)" : "var(--text)" }}>{p.message}</span>
                          {p.rest !== "" && (
                            <span style={{ color: "var(--text-3)" }}>{"  "}{p.rest}</span>
                          )}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            )}

            <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--text-3)" }}>
              Searched back to {new Date(trace.searched.fromMs).toLocaleString()}
              {trace.model !== null && ` · explained by ${trace.model}`}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
