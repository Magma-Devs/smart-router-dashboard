"use client";
import { useState } from "react";
import { useAsk } from "./AskProvider";
import { AskConversation } from "./AskConversation";
import { AskHistory } from "./AskHistory";
import { AskIcon } from "./AskIcon";

/** The Ask page: one conversation, with the person's history a click away. */
export function AskPage() {
  const ask = useAsk();
  const [history, setHistory] = useState(false);
  if (ask.loading)
    return (
      <section className="ask-unavailable">
        <p role="status">Connecting to your chats…</p>
      </section>
    );
  if (!ask.visible)
    return (
      <section className="ask-unavailable">
        <h1>Chat is unavailable</h1>
        <p>Ask your data isn’t enabled on this dashboard.</p>
      </section>
    );
  return (
    <section className="ask-page" aria-label="Ask your data">
      <div className="ask-page-actions">
        <button
          className="gw-btn gw-btn--ghost"
          aria-pressed={history}
          onClick={() => setHistory(!history)}
        >
          <AskIcon name={history ? "back" : "history"} size={14} />
          {history ? "Back to chat" : "History"}
        </button>
        <button
          className="gw-btn gw-btn--ghost"
          disabled={ask.submitting}
          onClick={() => {
            setHistory(false);
            ask.select(null);
          }}
        >
          <AskIcon name="plus" size={14} />
          New chat
        </button>
      </div>
      {history ? (
        <AskHistory key={ask.scope} onSelect={() => setHistory(false)} />
      ) : ask.invalidLink ? (
        <div className="ask-thread ask-empty" role="alert">
          <h2>This chat link is invalid</h2>
          <button className="gw-btn" onClick={() => ask.select(null)}>
            Start a new chat
          </button>
        </div>
      ) : (
        <AskConversation key={`${ask.scope}:${ask.chatId ?? "new"}`} />
      )}
    </section>
  );
}
