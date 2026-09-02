"use client";

import { useCallback, useEffect, useState } from "react";
import type { TraceAiProviderId, TraceAiSettings, TraceModelsResponse } from "@sr/shared";
import { ApiError, apiPost } from "@/lib/api-client";
import {
  EMPTY_SETTINGS,
  PROVIDER_DEFAULT_MODEL,
  PROVIDER_KEY_URL,
  PROVIDER_LABEL,
  clearTraceSettings,
  hasUsableKey,
  loadTraceSettings,
  maskKey,
  saveTraceSettings,
} from "@/lib/trace-settings";

const PROVIDERS: TraceAiProviderId[] = ["anthropic", "gemini"];

type ModelsState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; models: { id: string; label: string }[]; defaultModel: string }
  | { phase: "error"; message: string };

/**
 * Model settings for the Relay Investigator, shown on the investigator pages
 * themselves rather than in Account — it configures this one feature, and
 * putting it where the feature is means nobody has to know it exists.
 *
 * The key is saved in this browser and sent with each ask; the api uses it for
 * that one call and never writes it down.
 */
export function TraceAiSettingsCard({ onChanged }: { onChanged?: () => void }) {
  const [saved, setSaved] = useState<TraceAiSettings | null>(null);
  const [draft, setDraft] = useState<TraceAiSettings>(EMPTY_SETTINGS);
  const [editing, setEditing] = useState(false);
  const [models, setModels] = useState<ModelsState>({ phase: "idle" });

  useEffect(() => {
    const s = loadTraceSettings();
    setSaved(s);
    setDraft(s ?? EMPTY_SETTINGS);
    setEditing(!hasUsableKey(s));
  }, []);

  /** Ask the provider what it will answer to. A checked-in list goes stale the
   *  week a provider ships or retires something — which happened to this
   *  feature mid-build. */
  const loadModels = useCallback(async (provider: TraceAiProviderId | null, apiKey: string) => {
    setModels({ phase: "loading" });
    try {
      const res = await apiPost<TraceModelsResponse>("/api/trace/models", {
        // A null provider means "whatever this deployment is set up for" —
        // used on first run so the picker opens on the provider that actually
        // has a key, rather than on an alphabetical default that errors.
        ...(provider === null ? {} : { provider }),
        ...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }),
      });
      setModels({ phase: "ready", models: res.models, defaultModel: res.defaultModel });
      return res.provider;
    } catch (e) {
      setModels({
        phase: "error",
        message: e instanceof ApiError ? e.message : "Could not load the model list.",
      });
      return null;
    }
  }, []);

  // Load once the draft has a key to load them with — either the reader's, or
  // (with the field blank) whatever the deployment is configured with.
  /** True until the reader has picked a provider themselves, so the first
   *  load can adopt whatever the deployment is configured for. */
  const [providerPicked, setProviderPicked] = useState(false);

  useEffect(() => {
    if (!editing) return;
    void loadModels(providerPicked ? draft.provider : null, draft.apiKey).then((p) => {
      if (p !== null && !providerPicked) setDraft((d) => ({ ...d, provider: p }));
    });
    // Re-fetch when the provider changes, not on every keystroke of the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, providerPicked, draft.provider]);

  function save() {
    const next: TraceAiSettings = {
      provider: draft.provider,
      model: draft.model.trim(),
      apiKey: draft.apiKey.trim(),
    };
    saveTraceSettings(next);
    setSaved(next);
    setEditing(false);
    onChanged?.();
  }

  function forget() {
    clearTraceSettings();
    setSaved(null);
    setDraft(EMPTY_SETTINGS);
    setEditing(true);
    onChanged?.();
  }

  const configured = hasUsableKey(saved);

  return (
    <div className="gw-card">
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Model settings</div>

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
                  onClick={() => { setProviderPicked(true); setDraft((d) => ({ ...d, provider: p, model: "" })); }}
                  style={{ fontSize: 12 }}
                >
                  {PROVIDER_LABEL[p]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div style={labelStyle}>API key</div>
            <input
              className="gw-input gw-mono"
              type="password"
              value={draft.apiKey}
              onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
              onBlur={() => void loadModels(draft.provider, draft.apiKey)}
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
              . Loading the model list below also checks it works.
            </div>
          </div>

          <div>
            <div style={labelStyle}>Model</div>
            {models.phase === "ready" ? (
              <select
                className="gw-input gw-mono"
                value={draft.model}
                onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
                style={{ width: "100%" }}
              >
                <option value="">{models.defaultModel} (default)</option>
                {models.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label === m.id ? m.id : `${m.label} — ${m.id}`}
                  </option>
                ))}
              </select>
            ) : (
              // The list is fetched from the provider, so it is unavailable
              // exactly when the key is wrong or the provider is unreachable.
              // A text field then is a fallback, not the normal path.
              <input
                className="gw-input gw-mono"
                value={draft.model}
                onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
                placeholder={PROVIDER_DEFAULT_MODEL[draft.provider]}
                spellCheck={false}
                style={{ width: "100%" }}
              />
            )}
            <div style={hintStyle}>
              {models.phase === "loading" && "Asking the provider what it will accept…"}
              {models.phase === "ready" &&
                `${models.models.length} models this key can use. Leave on the default unless you have a reason.`}
              {models.phase === "error" && (
                <span style={{ color: "var(--warn)" }}>
                  {models.message} Type a model id instead, or{" "}
                  <button
                    onClick={() => void loadModels(draft.provider, draft.apiKey)}
                    style={{ background: "none", border: "none", padding: 0, color: "var(--brand)", cursor: "pointer", font: "inherit" }}
                  >
                    retry
                  </button>
                  .
                </span>
              )}
              {models.phase === "idle" && "Enter a key to load the list."}
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
        Saved in this browser only and sent with each request &mdash; the dashboard server never
        stores it, so what you spend is yours. It does not follow you to another device, and
        anything able to run script on this page could read it, so use a key scoped to model access
        and remove it when you are done. Without a key this page still shows the log lines.
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
