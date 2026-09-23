"use client";

/**
 * The cross-tab brief.
 *
 * Every other surface on this page computes itself; this one is asked for.
 *
 * It renders nothing on its own authority: each theme lists the findings it
 * rests on, using the ids the api already validated against the report. A
 * theme that cited nothing real was deleted server-side before it arrived, and
 * `droppedUncited` reports how many — surfaced rather than hidden, because a
 * model inventing themes is something the operator should see.
 */
import { useState } from "react";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { apiPostResult } from "@/lib/api-client";

interface Theme {
  title: string;
  detail: string;
  severity: "critical" | "degraded" | "advisory";
  findingIds: string[];
}

interface Brief {
  ok: true;
  headline: string;
  themes: Theme[];
  customerMessage: string | null;
  droppedUncited: number;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  input: { findings: number; insights: number; incidents: number };
}

interface Refusal {
  ok: false;
  reason: string;
  detail?: string;
}

/** The page's three severities, in its own colours. */
const TONE: Record<Theme["severity"], { dot: string; label: string }> = {
  critical: { dot: "var(--danger, #ef4444)", label: "Critical" },
  degraded: { dot: "var(--warn, #f59e0b)", label: "Degraded" },
  advisory: { dot: "var(--muted-fg, #64748b)", label: "Advisory" },
};

/** What a refusal means, in the operator's terms rather than the api's. */
function refusalText(r: Refusal): string {
  if (r.reason === "disabled") return "AI is not enabled on this deployment (BEDROCK_ENABLED).";
  if (r.reason === "auth_required") return "AI needs sign-in to be enabled on this deployment.";
  if (r.reason === "model_call_failed") return `The model could not be reached. ${r.detail ?? ""}`.trim();
  return r.reason;
}

export function BriefPanel() {
  const { timeWindow, scopeQ } = useFilters();
  const [brief, setBrief] = useState<Brief | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    setRefusal(null);
    try {
      const { body } = await apiPostResult<Brief | Refusal>(
        `/api/ai/status-analysis?window=${timeWindow}${scopeQ}`,
      );
      if (body.ok) {
        setBrief(body);
      } else {
        setBrief(null);
        setRefusal(body);
      }
    } catch (err) {
      setBrief(null);
      setRefusal({ ok: false, reason: "model_call_failed", detail: String(err) });
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="gw-card" style={{ marginBottom: 16 }}>
      {/* No standfirst. The button says what it does, and a paragraph
          explaining the mechanism sat above every row on the page for the sake
          of a control most people press once. */}
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: brief || refusal ? 12 : 0 }}>
        <button className="gw-btn" onClick={run} disabled={running} style={{ whiteSpace: "nowrap" }}>
          {running ? "Reading…" : brief ? "Run again" : "Explain"}
        </button>
      </div>

      {refusal && (
        <div style={{ fontSize: 12, color: "var(--muted-fg)", paddingTop: 4 }}>{refusalText(refusal)}</div>
      )}

      {brief && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>{brief.headline}</div>

          {brief.themes.length === 0 && (
            // Not "all clear" — the page never says that. No rule crossed.
            <div style={{ fontSize: 12, color: "var(--muted-fg)" }}>
              Nothing the findings share a cause across.
            </div>
          )}

          {brief.themes.map((t) => (
            <div key={t.title} style={{ borderLeft: `2px solid ${TONE[t.severity].dot}`, paddingLeft: 10 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: TONE[t.severity].dot }}>
                  {TONE[t.severity].label}
                </span>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t.title}</span>
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.55, marginTop: 4 }}>{t.detail}</div>
              {/* The receipts. Every theme rests on rows already on this page. */}
              <div style={{ fontSize: 10, color: "var(--muted-fg)", marginTop: 5, fontFamily: "var(--font-mono)" }}>
                {t.findingIds.join(" · ")}
              </div>
            </div>
          ))}

          {brief.customerMessage && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>For the customer</div>
              <div style={{ fontSize: 12, lineHeight: 1.55, color: "var(--muted-fg)" }}>{brief.customerMessage}</div>
              <button
                className="gw-btn"
                style={{ marginTop: 6, fontSize: 11 }}
                onClick={() => navigator.clipboard?.writeText(brief.customerMessage ?? "")}
              >
                Copy
              </button>
            </div>
          )}

          <div style={{ fontSize: 10, color: "var(--muted-fg)" }}>
            Read {brief.input.findings} findings · {brief.input.incidents} incidents ·{" "}
            {brief.input.insights} insights
            {brief.droppedUncited > 0 && (
              // Worth seeing: the model produced claims that rested on nothing
              // in the report, and they were dropped before reaching here.
              <> · {brief.droppedUncited} unsupported {brief.droppedUncited === 1 ? "theme" : "themes"} dropped</>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
