"use client";

import { useEffect, useState } from "react";
import type { TraceAiProviderId, TraceAiSettings } from "@sr/shared";
import {
  EMPTY_SETTINGS,
  PROVIDER_DEFAULT_MODEL,
  PROVIDER_KEY_URL,
  PROVIDER_LABEL,
  clearTraceSettings,
  hasUsableKey,
  loadTraceSettings,
  maskKey,
} from "@/lib/trace-settings";
import { saveTraceSettings } from "@/lib/trace-settings";

const PROVIDERS: TraceAiProviderId[] = ["anthropic", "gemini"];

/**
 * Model settings for the Relay Trace explanation, on the Account page.
 *
 * Deliberately browser-local: the key is saved here and sent with each ask,
 * and the api never writes it down. Each person brings their own and spends
 * their own budget.
 */
export function TraceAiSettingsCard() {
  const [saved, setSaved] = useState<TraceAiSettings | null>(null);
  const [draft, setDraft] = useState<TraceAiSettings>(EMPTY_SETTINGS);
  const [editing, setEditing] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  // Read once on mount: localStorage is a browser API, and reading it during
  // render would differ between the server pass and the client one.
  useEffect(() => {
    const s = loadTraceSettings();
    setSaved(s);
    setDraft(s ?? EMPTY_SETTINGS);
    setEditing(!hasUsableKey(s));
  }, []);

  function save() {
    const next: TraceAiSettings = {
      provider: draft.provider,
      model: draft.model.trim(),
      apiKey: draft.apiKey.trim(),
    };
    saveTraceSettings(next);
    setSaved(next);
    setEditing(false);
    setJustSaved(true);
    window.setTimeout(() => setJustSaved(false), 2500);
  }

  function forget() {
    clearTraceSettings();
    setSaved(null);
    setDraft(EMPTY_SETTINGS);
    setEditing(true);
  }

  const configured = hasUsableKey(saved);

  return (
    <div className="gw-card" style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Relay trace &mdash; AI explanation</div>
        {justSaved && <div style={{ fontSize: 11.5, color: "var(--ok)" }}>Saved</div>}
      </div>

      <p style={{ marginTop: 0, marginBottom: 14, fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.6 }}>
        Your own key, used to explain a relay on the{" "}
        <a href="/trace" style={{ color: "var(--brand)" }}>Relay trace</a> page. It is stored in this
        browser and sent with each request; the dashboard server never saves it, so what you spend is
        yours and nobody else on this deployment can use it.
      </p>

      {configured && !editing ? (
        <div style={{ display: "grid", gap: 10 }}>
          <Row label="Provider" value={PROVIDER_LABEL[saved.provider]} />
          <Row label="Model" value={saved.model || `${PROVIDER_DEFAULT_MODEL[saved.provider]} (default)`} mono />
          <Row label="API key" value={maskKey(saved.apiKey)} mono />
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button className="gw-btn" onClick={() => setEditing(true)} style={{ fontSize: 12 }}>Change</button>
            <button className="gw-btn gw-btn--danger" onClick={forget} style={{ fontSize: 12 }}>
              Remove from this browser
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12, maxWidth: 460 }}>
          <div>
            <div style={labelStyle}>Provider</div>
            <div style={{ display: "flex", gap: 8 }}>
              {PROVIDERS.map((p) => (
                <button
                  key={p}
                  className={draft.provider === p ? "gw-btn gw-btn--primary" : "gw-btn"}
                  onClick={() => setDraft((d) => ({ ...d, provider: p }))}
                  style={{ fontSize: 12 }}
                >
                  {PROVIDER_LABEL[p]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div style={labelStyle}>Model</div>
            <input
              className="gw-input gw-mono"
              value={draft.model}
              onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
              placeholder={PROVIDER_DEFAULT_MODEL[draft.provider]}
              spellCheck={false}
              style={{ width: "100%" }}
            />
            {/* Free text rather than a dropdown on purpose: providers add and
                retire models faster than this dashboard ships, and a stale
                list would block the newer model rather than help. */}
            <div style={hintStyle}>
              Leave blank for {PROVIDER_DEFAULT_MODEL[draft.provider]}. Any model id this provider
              accepts works &mdash; a retired one comes back as an error naming its replacement.
            </div>
          </div>

          <div>
            <div style={labelStyle}>API key</div>
            <input
              className="gw-input gw-mono"
              type="password"
              value={draft.apiKey}
              onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
              placeholder={draft.provider === "anthropic" ? "sk-ant-…" : "AIza…"}
              spellCheck={false}
              autoComplete="off"
              style={{ width: "100%" }}
            />
            <div style={hintStyle}>
              Get one from{" "}
              <a href={PROVIDER_KEY_URL[draft.provider]} target="_blank" rel="noopener noreferrer" style={{ color: "var(--brand)" }}>
                {draft.provider === "anthropic" ? "console.anthropic.com" : "aistudio.google.com"}
              </a>
              .
            </div>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="gw-btn gw-btn--primary"
              onClick={save}
              disabled={draft.apiKey.trim() === ""}
              style={{ fontSize: 12 }}
            >
              Save to this browser
            </button>
            {configured && (
              <button className="gw-btn" onClick={() => { setDraft(saved); setEditing(false); }} style={{ fontSize: 12 }}>
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {/* The honest caveat, where someone deciding whether to paste a key can
          actually read it. */}
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line)", fontSize: 11.5, color: "var(--text-3)", lineHeight: 1.6 }}>
        Stored in this browser&rsquo;s local storage, so it does not follow you to another device and
        anything able to run script on this page could read it. Use a key scoped to model access
        only, and remove it here when you are done. Without a key the Relay trace page still works
        &mdash; it just shows the log lines without an explanation.
      </div>
    </div>
  );
}

const labelStyle = {
  fontSize: 11,
  color: "var(--text-3)",
  textTransform: "uppercase" as const,
  letterSpacing: "0.07em",
  fontWeight: 600,
  marginBottom: 6,
};

const hintStyle = { fontSize: 11.5, color: "var(--text-3)", marginTop: 5, lineHeight: 1.5 };

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      <div className={mono ? "gw-mono" : undefined} style={{ fontSize: 12.5 }}>{value}</div>
    </div>
  );
}
