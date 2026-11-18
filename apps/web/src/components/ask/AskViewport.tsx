"use client";
import { useEffect, useRef, useState } from "react";
import { useAsk } from "./AskProvider";
import { AskConversation } from "./AskConversation";
import { AskHistory } from "./AskHistory";
import { AskTurnOff } from "./AskSwitch";
import { useDialogLayer } from "@/components/gateway/DialogLayer";
import { AskIcon } from "./AskIcon";

function PreferenceNotice() {
  const ask = useAsk();
  return ask.preferenceError ? (
    <div className="ask-notice" role="status">
      Your view preference couldn’t be saved.{" "}
      <button className="gw-btn gw-btn--ghost" onClick={ask.retryPreferences}>
        Retry saving
      </button>
    </div>
  ) : null;
}
function AskBody({
  history,
  closeHistory,
  full,
}: {
  history: boolean;
  closeHistory: () => void;
  full?: boolean;
}) {
  const ask = useAsk();
  return (
    <div className={`ask-body${history ? " ask-body--history" : ""}`}>
      {full || history ? (
        <aside className="ask-history-column" aria-label="Your chat history">
          <AskHistory onSelect={closeHistory} showAccount={full} />
        </aside>
      ) : null}
      <div className="ask-chat-column">
        {ask.invalidLink ? (
          <div className="ask-empty" role="alert">
            <h2>This chat link is invalid</h2>
            <button className="gw-btn" onClick={() => ask.select(null)}>
              Start a new chat
            </button>
          </div>
        ) : (
          <AskConversation key={ask.chatId ?? "new"} />
        )}
      </div>
    </div>
  );
}
export function AskFull() {
  const ask = useAsk();
  const [history, setHistory] = useState(false);
  if (ask.loading)
    return (
      <section className="ask-unavailable">
        <h1>Ask your data</h1>
        <p role="status">Connecting to your chats…</p>
      </section>
    );
  if (!ask.visible && !ask.loading)
    return (
      <section className="ask-unavailable">
        <h1>Chat is unavailable</h1>
        <p>Ask your data isn’t enabled on this dashboard.</p>
        <a href="/metrics" className="gw-btn">
          Back to dashboard
        </a>
      </section>
    );
  return (
    <section className="ask-full" aria-label="Ask your data">
      <header className="ask-header">
        <div>
          <h1>Ask your data</h1>
        </div>
        <div className="ask-header-actions">
          <button
            className="gw-btn gw-btn--ghost ask-mobile-history"
            aria-pressed={history}
            onClick={() => setHistory(!history)}
          >
            <AskIcon name={history ? "back" : "history"} />
            {history ? "Back to chat" : "History"}
          </button>
          <button
            className="gw-btn gw-btn--ghost ask-header-new"
            onClick={() => ask.select(null)}
            disabled={ask.submitting}
          >
            + New chat
          </button>
          <AskTurnOff />
          <button className="gw-btn" onClick={ask.back}>
            <AskIcon name="back" size={14} />
            Back to dashboard
          </button>
        </div>
      </header>
      <PreferenceNotice />
      <AskBody key={ask.scope} full history={history} closeHistory={() => setHistory(false)} />
    </section>
  );
}

export function AskDock() {
  const ask = useAsk();
  const [history, setHistory] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const [mobile, setMobile] = useState(false);
  const open = ask.visible && !ask.full && ask.mode === "panel";
  useDialogLayer(panel, { active: open && mobile, onEscape: ask.minimize });
  useEffect(() => {
    const media = matchMedia("(max-width: 760px)");
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!open) return;
    const target = panel.current?.querySelector<HTMLElement>(
      "textarea:not(:disabled),button:not(:disabled)",
    );
    target?.focus({ preventScroll: true });
    if (!mobile) return;
    const background = document.querySelector<HTMLElement>(".gw-app");
    const previousInert = background?.inert ?? false;
    if (background) background.inert = true;
    return () => {
      if (background) background.inert = previousInert;
      document.querySelector<HTMLButtonElement>(".ask-trigger")?.focus({ preventScroll: true });
    };
  }, [open, mobile]);
  if (!ask.visible || ask.full) return null;
  if (ask.mode === "minimized")
    return (
      <button
        className="ask-pill"
        onClick={() => void ask.open()}
        aria-label={ask.active ? "Open chat, question processing" : "Open chat"}
      >
        <span aria-hidden="true">✦</span>
        <strong>Ask your data</strong>
        <span>{ask.active ? "Processing…" : "Open chat"}</span>
        {ask.active ? <span className="ask-spinner" aria-hidden="true" /> : null}
      </button>
    );
  if (!open) return null;
  return (
    <aside
      ref={panel}
      tabIndex={-1}
      className="ask-panel"
      role={mobile ? "dialog" : "complementary"}
      aria-modal={mobile || undefined}
      aria-labelledby="ask-panel-title"
      onKeyDown={(event) => {
        if (!mobile && event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          ask.minimize();
        }
      }}
    >
      <header className="ask-header">
        <div>
          <h2 id="ask-panel-title">
            <span className="ask-avatar">
              <AskIcon name="sparkle" size={17} />
            </span>
            Ask your data
          </h2>
        </div>
        <div className="ask-header-actions">
          <button
            className="gw-btn gw-btn--ghost"
            title="Open full chat"
            aria-label="Open full chat"
            onClick={ask.expand}
          >
            <AskIcon name="expand" />
          </button>
          <button
            className="gw-btn gw-btn--ghost"
            title="Minimize chat"
            aria-label="Minimize chat"
            onClick={ask.minimize}
          >
            <AskIcon name="minimize" />
          </button>
          <button
            className="gw-btn gw-btn--ghost"
            title="Close chat"
            aria-label="Close chat"
            onClick={ask.close}
          >
            <AskIcon name="close" />
          </button>
        </div>
      </header>
      <div className="ask-toolbar">
        <button
          className="gw-btn gw-btn--ghost"
          aria-pressed={history}
          onClick={() => setHistory(!history)}
        >
          <AskIcon name={history ? "back" : "history"} size={14} />
          {history ? "← Back to chat" : "History"}
        </button>
        <button
          className="gw-btn gw-btn--ghost"
          disabled={ask.submitting}
          onClick={() => {
            ask.select(null);
            setHistory(false);
          }}
        >
          + New chat
        </button>
        <AskTurnOff />
        <span>Private to you</span>
      </div>
      <PreferenceNotice />
      <AskBody key={ask.scope} history={history} closeHistory={() => setHistory(false)} />
    </aside>
  );
}
