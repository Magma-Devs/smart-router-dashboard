"use client";

import { useCallback, useEffect, useState } from "react";
import type { RelayTrace, TraceExplainResult, TraceSeverity } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { ApiError, apiPost } from "@/lib/api-client";
import { PROVIDER_DEFAULT_MODEL, hasUsableKey, loadTraceSettings } from "@/lib/trace-settings";
import type { TraceAiSettings } from "@sr/shared";
import { TraceSearch } from "./TraceSearch";
import { TraceAiSettingsCard } from "./TraceAiSettingsCard";

/** Severity → the existing tag vocabulary. Nothing here invents its own. */
const SEVERITY_TAG: Record<TraceSeverity, string> = {
  info: "gw-tag gw-tag--info",
  warning: "gw-tag gw-tag--warn",
  critical: "gw-tag gw-tag--err",
};

/** Level → colour. Log levels are the router's own vocabulary, not
 *  `HealthState`, so they get their own colours but reuse the same tokens. */
const LEVEL_COLOR: Record<string, string> = {
  error: "var(--err)",
  warn: "var(--warn)",
  debug: "var(--text-3)",
  info: "var(--info)",
  trace: "var(--text-4)",
};

function clock(tMs: number): string {
  return new Date(tMs).toLocaleTimeString(undefined, { hour12: false }) + "." +
    String(tMs % 1000).padStart(3, "0");
}

/**
 * Split one raw line into a headline and its remaining fields, FOR DISPLAY.
 *
 * Presentation only — the explain route still sends the model the raw line
 * verbatim, so the "no log parser" contract in docs/trace-ai-page holds. What
 * it drops is pure duplication: `GUID` is the value you searched for and
 * repeats on every line, `time` is already in the gutter, and `level` is
 * rendered as a tag. Together that is roughly a third of every line.
 */
function present(line: string): { message: string; rest: string } {
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    if (typeof o !== "object" || o === null) return { message: line, rest: "" };
    const message = typeof o.message === "string" ? o.message : "";
    const rest = Object.entries(o)
      .filter(([k]) => k !== "message" && k !== "GUID" && k !== "time" && k !== "level")
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join("  ");
    if (message === "" && rest === "") return { message: line, rest: "" };
    return { message: message || "(no message)", rest };
  } catch {
    // Not JSON — the router's first bootstrap lines aren't. Show it as it came.
    return { message: line, rest: "" };
  }
}

type AskState =
  | { phase: "idle" }
  | { phase: "asking" }
  | { phase: "done"; result: TraceExplainResult }
  | { phase: "error"; message: string };

export function TraceView({ guid }: { guid: string }) {
  // No polling and no refetch: a trail is fixed history.
  const { data: trace, error, isLoading } = useApi<RelayTrace>(`/api/trace/${guid}`, 0);
  const [ask, setAsk] = useState<AskState>({ phase: "idle" });
  /** null = follow the default: open when there is no answer yet, since the
   *  lines are then the only content on the page. */
  const [showLinesPref, setShowLinesPref] = useState<boolean | null>(null);
  const [errorsOnly, setErrorsOnly] = useState(false);
  /** This browser's own key, if the reader saved one in Account settings.
   *  Read on mount — localStorage differs between the server pass and the
   *  client one. */
  const [mySettings, setMySettings] = useState<TraceAiSettings | null>(null);
  useEffect(() => setMySettings(loadTraceSettings()), []);
  const [showSettings, setShowSettings] = useState(false);

  const askAi = useCallback(async () => {
    setAsk({ phase: "asking" });
    try {
      // Send this browser's key when there is one; an empty body means "use
      // whatever the deployment is configured with".
      const result = await apiPost<TraceExplainResult>(
        `/api/trace/${guid}/explain`,
        hasUsableKey(mySettings)
          ? { provider: mySettings.provider, model: mySettings.model, apiKey: mySettings.apiKey }
          : {},
      );
      setAsk({ phase: "done", result });
      // Collapse the lines once there is an answer to read, unless the reader
      // has already made that choice themselves.
      setShowLinesPref((p) => (p === null ? false : p));
    } catch (e) {
      setAsk({
        phase: "error",
        message: e instanceof ApiError ? e.message : "The explanation could not be generated.",
      });
    }
  }, [guid, mySettings]);

  const answered = ask.phase === "done";
  const showLines = showLinesPref ?? !answered;
  const errorCount = trace?.lines.filter((l) => l.level === "error").length ?? 0;
  const visibleLines = (trace?.lines ?? []).filter((l) => !errorsOnly || l.level === "error");
  const explanation = ask.phase === "done" ? ask.result.explanation : null;
  /** Either source of a key makes the ask possible: this browser's, or the
   *  one the deployment was configured with. */
  const myKey = hasUsableKey(mySettings);
  const canAsk = myKey || trace?.aiAvailable === true;
  // Name the actual model, not "gemini default" — the reader wants to know
  // what answered, and a blank field means the provider's default.
  const modelLabel = myKey
    ? mySettings.model.trim() || PROVIDER_DEFAULT_MODEL[mySettings.provider]
    : (trace?.model ?? "");

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
          {/* ---- Ask AI ---- */}
          {explanation === null && (
            <div className="gw-card">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <div className="gw-label" style={{ marginBottom: 4 }}>
                    {trace.lines.length} log lines for this relay
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--text-3)" }}>
                    {trace.lines.length === 0
                      ? "Nothing to explain — no lines carry this GUID in the window searched."
                      : canAsk
                        // Provider-agnostic: the model is named from whichever
                        // source supplied the key. Hardcoding "Claude" was
                        // wrong the moment Gemini could answer.
                        ? `The model reads them and explains what the router did${modelLabel ? ` · ${modelLabel}` : ""}${myKey ? " · your key" : ""}.`
                        : "No model key is configured. Add your own to explain this relay."}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                {trace.lines.length > 0 && (
                  <button
                    className="gw-btn gw-btn--ghost"
                    onClick={() => setShowSettings((v) => !v)}
                    style={{ fontSize: 12 }}
                  >
                    {showSettings ? "Close settings" : "Model settings"}
                  </button>
                )}
                {canAsk && trace.lines.length > 0 && (
                  <button
                    className="gw-btn gw-btn--primary"
                    onClick={askAi}
                    disabled={ask.phase === "asking"}
                    style={{ display: "inline-flex", alignItems: "center", gap: 8, flexShrink: 0 }}
                  >
                    {ask.phase === "asking" ? (
                      <>
                        <Spinner /> Reading the logs…
                      </>
                    ) : (
                      <>✦ Ask AI</>
                    )}
                  </button>
                )}
                </div>
              </div>

              {showSettings && (
                <div style={{ marginTop: 14 }}>
                  {/* Re-read the saved settings on change so the Ask button and
                      the model label follow immediately. */}
                  <TraceAiSettingsCard defaultOpen onChanged={() => setMySettings(loadTraceSettings())} />
                </div>
              )}

              {!canAsk && !showSettings && trace.lines.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <button className="gw-btn" onClick={() => setShowSettings(true)} style={{ fontSize: 12 }}>
                    Add a model key
                  </button>
                </div>
              )}

              {ask.phase === "error" && (
                <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--err)" }}>
                  {ask.message} The log lines below are unaffected.
                </div>
              )}
            </div>
          )}

          {/* ---- The answer ---- */}
          {explanation !== null && (
            <div className="gw-card gw-card--accent">
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                <div className="gw-label" style={{ marginBottom: 8 }}>What happened</div>
                <button className="gw-btn gw-btn--ghost" onClick={askAi} style={{ fontSize: 12 }}>
                  Ask again
                </button>
              </div>
              <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>{explanation.summary}</p>
            </div>
          )}

          {explanation !== null && (
            <div className="gw-card">
              <div className="gw-label" style={{ marginBottom: 12 }}>Timeline</div>
              {explanation.timeline.length > 0 ? (
                <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 10 }}>
                  {explanation.timeline.map((step, i) => (
                    <li key={i} style={{ display: "grid", gridTemplateColumns: "88px 1fr", gap: 12, alignItems: "baseline" }}>
                      <span className="gw-mono gw-tnum" style={{ fontSize: 11.5, color: "var(--text-3)" }}>{step.at}</span>
                      <span style={{ fontSize: 13.5 }}>{step.what}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <Empty>No step the log lines support. That usually means the trail is too thin to order — check the lines below.</Empty>
              )}
            </div>
          )}

          {explanation !== null && (
            <div className="gw-card">
              <div className="gw-label" style={{ marginBottom: 12 }}>Findings</div>
              {explanation.findings.length === 0 && (
                // An unremarkable relay HAS no findings, and the prompt tells
                // the model not to manufacture concerns. Say that, rather than
                // dropping the section — a page whose shape changes between
                // relays reads as broken.
                <Empty>Nothing an operator needs to act on. The relay behaved as configured.</Empty>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {explanation.findings.map((f, i) => (
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

          {/* ---- The evidence ---- */}
          <div className="gw-card">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div className="gw-label">
                Log lines ({trace.lines.length}{trace.truncated ? ", truncated" : ""})
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
                          {p.rest !== "" && <span style={{ color: "var(--text-3)" }}>{"  "}{p.rest}</span>}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            )}

            <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--text-3)" }}>
              Searched back to {new Date(trace.searched.fromMs).toLocaleString()}
              {ask.phase === "done" && ` · explained by ${ask.result.model}`}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The empty state for a section that is present but has nothing in it.
 *
 *  Every section renders on every trace. Hiding the ones that came back empty
 *  made the page a different shape for each relay, which reads as something
 *  having gone wrong — and it threw away real information, because "no
 *  findings" is a fact about the relay, not an absence of output. */
function Empty({ children }: { children: React.ReactNode }) {
  return <p style={{ margin: 0, color: "var(--text-3)", fontSize: 13 }}>{children}</p>;
}

/** Inline spinner for the Ask-AI button. A model call takes seconds, and a
 *  button that looks inert for that long reads as broken.
 *
 *  CSS-animated rather than SMIL so `prefers-reduced-motion` can stop it —
 *  a CSS rule cannot disable `<animateTransform>`. `.gw-spin` is in
 *  globals.css next to the other reduced-motion exemptions. */
function Spinner() {
  return (
    <svg className="gw-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
