"use client";

import { useState } from "react";
import {
  INCIDENT_LIMITS,
  INCIDENT_SEVERITIES,
  INCIDENT_SEVERITY_DESCRIPTIONS,
  INCIDENT_SEVERITY_LABELS,
  INCIDENT_SEVERITY_NEXT,
  buildChainMetaByIndex,
  newIncidentId,
  type IncidentReportRequest,
  type IncidentReportResponse,
  type IncidentSeverity,
} from "@sr/shared";
import { Modal } from "@/components/gateway/Modal";
import { useAuthMode } from "@/components/gateway/auth-mode";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { IconAlert } from "@/components/gateway/icons";
import { useMe } from "@/hooks/use-me";
import { apiPost } from "@/lib/api-client";
import { labelStyle } from "@/lib/styles";

/**
 * What the layout read from the web container's env, handed down rather than
 * asked of the api: a customer reports an incident exactly when something is
 * broken, and the api may be part of it. The button and the fallback contact
 * have to render without it.
 */
export interface IncidentsConfig {
  enabled: boolean;
  /** Where to go when the form cannot help — shown on every screen of it. */
  fallbackContact: string | null;
}

/** The top-bar button. Renders nothing while incident reporting is off. */
export function ReportIncidentButton({ config }: { config: IncidentsConfig }) {
  const [open, setOpen] = useState(false);
  if (!config.enabled) return null;
  return (
    <>
      <button className="gw-btn" onClick={() => setOpen(true)} title="Report an incident to Magma's engineers">
        <IconAlert size={14} />
        Report incident
      </button>
      <ReportIncidentModal open={open} onClose={() => setOpen(false)} fallbackContact={config.fallbackContact} />
    </>
  );
}

interface Draft {
  id: string;
  severity: IncidentSeverity | null;
  title: string;
  description: string;
  name: string;
  email: string;
  phone: string;
  includeScope: boolean;
}

const freshDraft = (): Draft => ({
  id: newIncidentId(),
  severity: null,
  title: "",
  description: "",
  name: "",
  email: "",
  phone: "",
  includeScope: true,
});

function ReportIncidentModal({
  open,
  onClose,
  fallbackContact,
}: {
  open: boolean;
  onClose: () => void;
  fallbackContact: string | null;
}) {
  const signedIn = useAuthMode();
  const { me } = useMe();
  const { chain, routerId } = useFilters();
  // The draft outlives a close on purpose. Somebody who closed the dialog after
  // a send that timed out and opens it again to retry keeps the same id, so the
  // retry joins the report that may already have landed instead of filing a
  // second one. Only a send that was accepted starts a new draft.
  const [draft, setDraft] = useState<Draft>(freshDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<IncidentReportResponse | null>(null);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const hasScope = Boolean(chain || routerId);

  function close() {
    if (busy) return;
    if (sent) {
      setDraft(freshDraft());
      setSent(null);
    }
    setError(null);
    onClose();
  }

  const missing =
    !draft.severity ||
    draft.title.trim() === "" ||
    (!signedIn && (draft.name.trim() === "" || draft.email.trim() === ""));

  async function submit() {
    if (!draft.severity) return;
    setBusy(true);
    setError(null);
    const body: IncidentReportRequest = {
      id: draft.id,
      severity: draft.severity,
      title: draft.title,
      description: draft.description.trim() || null,
      chain: draft.includeScope ? chain : null,
      routerId: draft.includeScope ? routerId : null,
      // With accounts on, the api takes the reporter from the session and
      // ignores this; it is not sent at all so the two can never disagree.
      reporter: signedIn ? undefined : { name: draft.name, email: draft.email, phone: draft.phone.trim() || null },
    };
    try {
      setSent(await apiPost<IncidentReportResponse>("/api/incidents", body));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The report could not be sent.");
    } finally {
      setBusy(false);
    }
  }

  const critical = draft.severity === "critical";
  return (
    <Modal
      open={open}
      onClose={close}
      md
      closeOnBackdrop={!busy && !sent}
      title={sent ? "Report sent" : "Report an incident"}
      footer={
        sent ? (
          <button className="gw-btn gw-btn--primary" onClick={close}>Done</button>
        ) : (
          <>
            <button className="gw-btn" disabled={busy} onClick={close}>Cancel</button>
            <button className="gw-btn gw-btn--primary" disabled={busy || missing} onClick={() => void submit()}>
              {busy ? "Sending…" : critical ? "Send and call the on-call" : "Send report"}
            </button>
          </>
        )
      }
    >
      {sent ? (
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            Your <strong>{INCIDENT_SEVERITY_LABELS[sent.severity]}</strong> report reached our on-call system at{" "}
            {new Date(sent.sentAt).toLocaleTimeString()}.
          </div>
          <div style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.6 }}>
            {INCIDENT_SEVERITY_NEXT[sent.severity]} Keep the reference below if you write to us about it.
          </div>
          <div>
            <div style={{ ...labelStyle, marginBottom: 6 }}>Reference</div>
            <div className="gw-mono" style={{ fontSize: 12, userSelect: "all" }}>{sent.id}</div>
          </div>
          <FallbackContact contact={fallbackContact} />
        </div>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          <div>
            <div style={{ ...labelStyle, marginBottom: 8 }}>Severity</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }} role="radiogroup" aria-label="Severity">
              {INCIDENT_SEVERITIES.map((s) => {
                const on = draft.severity === s;
                const accent = s === "critical" ? "var(--err)" : "var(--brand)";
                return (
                  <button
                    key={s}
                    role="radio"
                    aria-checked={on}
                    onClick={() => set({ severity: s })}
                    style={{
                      display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px", borderRadius: 8,
                      border: "1px solid " + (on ? accent : "var(--line)"),
                      background: on ? "color-mix(in srgb, " + accent + " 6%, var(--surface))" : "var(--surface)",
                      cursor: "pointer", textAlign: "left", fontFamily: "inherit", color: "var(--text)",
                    }}
                  >
                    <div style={{
                      width: 14, height: 14, borderRadius: "50%", flexShrink: 0, marginTop: 2,
                      border: "2px solid " + (on ? accent : "var(--line-2)"),
                      background: on ? accent : "transparent",
                    }} />
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{INCIDENT_SEVERITY_LABELS[s]}</div>
                      <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 2 }}>
                        {INCIDENT_SEVERITY_DESCRIPTIONS[s]}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div style={{ ...labelStyle, marginBottom: 6 }}>What is wrong</div>
            <input
              className="gw-input"
              placeholder="e.g. eth_call requests failing since 14:00"
              maxLength={INCIDENT_LIMITS.title}
              value={draft.title}
              onChange={(e) => set({ title: e.target.value })}
            />
          </div>
          <div>
            <div style={{ ...labelStyle, marginBottom: 6 }}>Details</div>
            <textarea
              className="gw-input"
              rows={4}
              placeholder="What you see, since when, and what it affects. Request IDs help."
              maxLength={INCIDENT_LIMITS.description}
              value={draft.description}
              onChange={(e) => set({ description: e.target.value })}
            />
          </div>

          {hasScope && (
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--text-2)" }}>
              <input
                type="checkbox"
                checked={draft.includeScope}
                onChange={(e) => set({ includeScope: e.target.checked })}
              />
              <span>
                About{" "}
                {chain && <strong>{buildChainMetaByIndex(chain).name}</strong>}
                {chain && routerId && ", "}
                {routerId && <>router <span className="gw-mono">{routerId}</span></>}
                {" "}— the filter on this page
              </span>
            </label>
          )}

          {signedIn ? (
            <div style={{ fontSize: 12.5, color: "var(--text-3)" }}>
              Reporting as <strong style={{ color: "var(--text-2)" }}>{me?.name || me?.email || "you"}</strong>
              {me?.name && me.email ? <> ({me.email})</> : null}. We reply to that address.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <div style={{ ...labelStyle, marginBottom: 6 }}>Your name</div>
                  <input
                    className="gw-input"
                    maxLength={INCIDENT_LIMITS.name}
                    value={draft.name}
                    onChange={(e) => set({ name: e.target.value })}
                  />
                </div>
                <div>
                  <div style={{ ...labelStyle, marginBottom: 6 }}>Email</div>
                  <input
                    className="gw-input"
                    type="email"
                    maxLength={INCIDENT_LIMITS.email}
                    value={draft.email}
                    onChange={(e) => set({ email: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <div style={{ ...labelStyle, marginBottom: 6 }}>Phone (optional)</div>
                <input
                  className="gw-input"
                  type="tel"
                  placeholder="A number we can call you back on"
                  maxLength={INCIDENT_LIMITS.phone}
                  value={draft.phone}
                  onChange={(e) => set({ phone: e.target.value })}
                />
              </div>
            </div>
          )}

          {error && (
            <div role="alert" style={{ fontSize: 12, color: "var(--err)", lineHeight: 1.5 }}>{error}</div>
          )}
          <FallbackContact contact={fallbackContact} />
        </div>
      )}
    </Modal>
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The way to reach us that does not depend on this form, the api behind it, or
 *  the cluster both run in. */
function FallbackContact({ contact }: { contact: string | null }) {
  if (!contact) return null;
  const link = EMAIL.test(contact)
    ? `mailto:${contact}`
    : /^https:\/\//i.test(contact)
      ? contact
      : null;
  return (
    <div style={{ fontSize: 12, color: "var(--text-3)", borderTop: "1px solid var(--line)", paddingTop: 10 }}>
      Form not working, or no answer? Contact{" "}
      {link ? (
        <a href={link} style={{ color: "var(--text-2)" }} target={link.startsWith("https") ? "_blank" : undefined} rel="noreferrer">
          {contact}
        </a>
      ) : (
        <strong style={{ color: "var(--text-2)" }}>{contact}</strong>
      )}
      .
    </div>
  );
}
