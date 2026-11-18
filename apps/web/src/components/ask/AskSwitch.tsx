"use client";
import { useState } from "react";
import { Modal } from "@/components/gateway/Modal";
import { useAsk } from "./AskProvider";

function failure(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "The switch could not be saved. Please try again.";
}

/** An admin's button that turns Ask off for everyone, behind a confirmation. */
export function AskTurnOff() {
  const ask = useAsk();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!ask.canSwitch || ask.off) return null;
  const turnOff = async () => {
    setBusy(true);
    setError(null);
    try {
      await ask.setOff(true);
      setConfirming(false);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className="gw-btn gw-btn--ghost"
        title="Turn Ask off for everyone"
        onClick={() => {
          setError(null);
          setConfirming(true);
        }}
      >
        Turn off
      </button>
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
              onClick={() => void turnOff()}
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
    </>
  );
}

/** What everyone sees while Ask is off; an admin can turn it back on here. */
export function AskOffNotice() {
  const ask = useAsk();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!ask.off) return null;
  return (
    <p className="ask-notice" role="status">
      An admin turned Ask off for everyone on this dashboard. You can still read your chats.
      {ask.canSwitch ? (
        <>
          {" "}
          <button
            type="button"
            className="gw-btn gw-btn--ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void ask
                .setOff(false)
                .catch((e: unknown) => setError(failure(e)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Turning on…" : "Turn Ask back on"}
          </button>
        </>
      ) : null}
      {error ? (
        <span role="alert" style={{ display: "block", color: "var(--err)" }}>
          {error}
        </span>
      ) : null}
    </p>
  );
}
