"use client";
import { useState } from "react";
import { Modal } from "@/components/gateway/Modal";
import Link from "next/link";
import { useAsk } from "./AskProvider";

function failure(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "The switch could not be saved. Please try again.";
}

/**
 * The Team page's switch, for an admin: turns Ask off for everyone behind a
 * confirmation, and back on. Drawn only where this person can use Ask.
 */
export function AskTeamSwitch() {
  const ask = useAsk();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!ask.canSwitch) return null;
  const set = async (off: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await ask.setOff(off);
      setConfirming(false);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ask-team-switch">
      <div>
        <strong>Ask your data</strong>
        <span>{ask.off ? "Off for everyone" : "On for everyone"}</span>
        {error && !confirming ? <span role="alert">{error}</span> : null}
      </div>
      {ask.off ? (
        <button type="button" className="gw-btn" disabled={busy} onClick={() => void set(false)}>
          {busy ? "Turning on…" : "Turn on"}
        </button>
      ) : (
        <button
          type="button"
          className="gw-btn"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
        >
          Turn off
        </button>
      )}
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Turn Ask off for everyone?"
        footer={
          <>
            <button className="gw-btn" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              className="gw-btn gw-btn--danger"
              disabled={busy}
              onClick={() => void set(true)}
            >
              {busy ? "Turning off…" : "Turn off Ask"}
            </button>
          </>
        }
      >
        <div style={{ display: "grid", gap: 12, fontSize: 13, lineHeight: 1.6 }}>
          <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-2)", fontSize: 12.5 }}>
            <li>Every question in progress stops within seconds, for everyone.</li>
            <li>Nobody can ask a new question until an admin turns Ask back on.</li>
            <li>Chats stay readable. The audit log records who turned it off.</li>
          </ul>
          {error ? (
            <div role="alert" style={{ fontSize: 12, color: "var(--err)" }}>
              {error}
            </div>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}

/** What everyone sees while Ask is off; an admin is pointed at the switch. */
export function AskOffNotice() {
  const ask = useAsk();
  if (!ask.off) return null;
  return (
    <p className="ask-notice" role="status">
      An admin turned Ask off for everyone on this dashboard. You can still read your chats.
      {ask.canSwitch ? (
        <>
          {" "}
          <Link href="/team">Turn it back on in Team</Link>
        </>
      ) : null}
    </p>
  );
}
