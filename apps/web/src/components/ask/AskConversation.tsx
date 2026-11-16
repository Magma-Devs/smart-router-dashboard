"use client";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import type { AskChatDetail } from "@sr/shared";
import { ApiError } from "@/lib/api-client";
import { useAsk } from "./AskProvider";
import { AskAnswer, AskTime } from "./AskAnswer";

export function AskConversation() {
  const ask = useAsk();
  const feed = useSWR<AskChatDetail>(
    ask.available && ask.chatId ? ["ask", ask.scope, "chat", ask.chatId] : null,
    () => ask.api.get(`/api/ask/chats/${ask.chatId}`),
    {
      refreshInterval: ask.active?.chatId === ask.chatId ? 1500 : 0,
      revalidateOnFocus: true,
      shouldRetryOnError: false,
      keepPreviousData: false,
    },
  );
  const [older, setOlder] = useState<{ chatId: string; pages: AskChatDetail[] }>({
    chatId: "",
    pages: [],
  });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const pages = older.chatId === ask.chatId ? older.pages : [];
  const data = ask.chatId ? feed.data : undefined;
  const messages = [
    ...new Map(
      [...pages.flatMap((page) => page.messages), ...(data?.messages ?? [])].map((message) => [
        message.id,
        message,
      ]),
    ).values(),
  ];
  const outcomes = new Map(
    [...pages.flatMap((page) => page.runs), ...(data?.runs ?? [])].map((run) => [run.id, run]),
  );
  const before = pages[0]?.nextMessageCursor ?? (pages.length ? null : data?.nextMessageCursor);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const lastChat = useRef<string | null>(null);
  const preserveHeight = useRef<number | null>(null);
  const latestId = messages.at(-1)?.id;
  const latestRole = messages.at(-1)?.role;
  const outcomeVersion = [...outcomes.values()].map((run) => `${run.id}:${run.status}`).join(",");
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (preserveHeight.current !== null) {
      element.scrollTop += element.scrollHeight - preserveHeight.current;
      preserveHeight.current = null;
    } else {
      if (lastChat.current !== ask.chatId) nearBottom.current = true;
      if (nearBottom.current) {
        const answer =
          latestId && latestRole === "assistant"
            ? element.querySelector<HTMLElement>(`[data-ask-message="${CSS.escape(latestId)}"]`)
            : null;
        if (answer)
          element.scrollTop +=
            answer.getBoundingClientRect().top - element.getBoundingClientRect().top - 24;
        else element.scrollTop = element.scrollHeight;
      }
    }
    lastChat.current = ask.chatId;
  }, [messages.length, latestId, latestRole, outcomeVersion, ask.chatId, ask.active?.status]);

  const loadOlder = async () => {
    if (!before || !ask.chatId || loadingOlder) return;
    const id = ask.chatId;
    setLoadingOlder(true);
    setOlderError(false);
    try {
      const page = await ask.api.get<AskChatDetail>(
        `/api/ask/chats/${id}?before=${encodeURIComponent(before)}`,
      );
      preserveHeight.current = scroller.current?.scrollHeight ?? null;
      setOlder((old) => ({ chatId: id, pages: [page, ...(old.chatId === id ? old.pages : [])] }));
    } catch {
      setOlderError(true);
    } finally {
      setLoadingOlder(false);
    }
  };
  const blocked =
    !ask.accepting ||
    !ask.activityKnown ||
    Boolean(ask.active) ||
    ask.submitting ||
    ask.navigating ||
    Boolean(ask.chatId && (feed.isLoading || feed.error));
  const focusedChat = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (feed.isLoading) return;
    const id = ask.chatId ?? "new";
    if (focusedChat.current !== id) {
      focusedChat.current = id;
      if (!blocked) composer.current?.focus({ preventScroll: true });
    }
  }, [ask.chatId, feed.isLoading, blocked]);
  const pageContext = ask.context(data?.context);
  return (
    <div className="ask-conversation">
      <div
        className="ask-transcript"
        ref={scroller}
        onScroll={() => {
          const element = scroller.current;
          if (element)
            nearBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 100;
        }}
        aria-label="Conversation"
        tabIndex={0}
      >
        {before ? (
          <button
            className="gw-btn ask-load-more"
            disabled={loadingOlder}
            onClick={() => void loadOlder()}
          >
            {loadingOlder ? "Loading…" : "Load earlier messages"}
          </button>
        ) : null}
        {olderError ? <p role="alert">Earlier messages couldn’t load. Please try again.</p> : null}
        {!ask.available ? (
          <div className="ask-empty">
            <h2>Chat is temporarily unavailable</h2>
            <p>Your conversations stay private. Try connecting again in a moment.</p>
            <button className="gw-btn" onClick={() => void ask.refresh()}>
              Retry connection
            </button>
          </div>
        ) : null}
        {ask.available && feed.isLoading ? (
          <p className="ask-muted" role="status">
            Loading conversation…
          </p>
        ) : null}
        {ask.available && feed.error ? (
          <div className="ask-empty" role="alert">
            <h2>
              {feed.error instanceof ApiError && feed.error.statusCode === 404
                ? "This chat couldn’t be found"
                : "This chat couldn’t load"}
            </h2>
            <p>It may have expired, or it may belong to another account.</p>
            <button className="gw-btn" onClick={() => void feed.mutate()}>
              Retry chat
            </button>
            <button className="gw-btn gw-btn--ghost" onClick={() => ask.select(null)}>
              Start a new chat
            </button>
          </div>
        ) : null}
        {ask.available && !feed.isLoading && !feed.error && !messages.length ? (
          <div className="ask-empty">
            <div className="ask-symbol" aria-hidden="true">
              ✦
            </div>
            <h2>Ask about your router</h2>
            <p>
              Explore your authorized metrics and logs. Follow up in the same conversation to keep
              the context.
            </p>
            <div className="ask-suggestions">
              {[
                "Which chains need attention?",
                "How has the error rate changed?",
                "What do the recent logs tell us?",
              ].map((question) => (
                <button
                  className="gw-btn gw-btn--ghost"
                  key={question}
                  onClick={() => {
                    ask.setDraft(question);
                    composer.current?.focus();
                  }}
                >
                  {question}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {messages.map((message) =>
          message.role === "assistant" && message.answer ? (
            <AskAnswer key={message.id} messageId={message.id} answer={message.answer} />
          ) : (
            <div className="ask-turn" key={message.id} data-ask-message={message.id}>
              <div className="ask-question">
                <div className="ask-message-meta">
                  <span>You</span>
                  <AskTime value={message.createdAt} />
                </div>
                <p dir="auto">{message.question}</p>
              </div>
              {outcomes.get(message.runId)?.error ? (
                <div className="ask-turn-error" role="status">
                  <p>{outcomes.get(message.runId)!.error!.message}</p>
                  <button
                    className="gw-btn gw-btn--ghost"
                    onClick={() => {
                      ask.setDraft(message.question ?? "");
                      composer.current?.focus();
                    }}
                  >
                    Edit and retry
                  </button>
                </div>
              ) : null}
            </div>
          ),
        )}
        {ask.active ? (
          <div className="ask-processing" role="status">
            <span className="ask-spinner" aria-hidden="true" />
            <div>
              {ask.active.status === "cancelling" ? "Stopping…" : "Processing…"}
              {ask.active.chatId !== ask.chatId ? (
                <button
                  className="gw-btn gw-btn--ghost"
                  onClick={() => ask.select(ask.active!.chatId)}
                >
                  View processing question
                </button>
              ) : (
                <small>You can minimize this chat and keep working.</small>
              )}
            </div>
            <button
              className="gw-btn"
              disabled={ask.active.status === "cancelling"}
              onClick={() => void ask.stop()}
            >
              Stop
            </button>
          </div>
        ) : null}
      </div>
      <form
        className="ask-composer"
        onSubmit={(event) => {
          event.preventDefault();
          nearBottom.current = true;
          void ask.submit(data?.context);
        }}
      >
        <div className="ask-context">
          <span>{pageContext.chain ?? "All chains"}</span>
          <span>
            {pageContext.page === "ask" ? "Conversation context" : `${pageContext.page} context`}
          </span>
          {pageContext.from && pageContext.to ? (
            <span title={`${pageContext.from} — ${pageContext.to}`}>
              {data?.context ? "Saved time window" : "Current time window"}
            </span>
          ) : null}
        </div>
        {ask.notice ? (
          <p className="ask-notice" role="alert">
            {ask.notice}
          </p>
        ) : null}
        {ask.available && !ask.accepting ? (
          <p className="ask-notice">
            New questions are temporarily unavailable. You can still read your history.
          </p>
        ) : null}
        {ask.available && !ask.activityKnown ? (
          <p className="ask-notice" role="status">
            Checking whether a question is already running…{" "}
            <button
              type="button"
              className="gw-btn gw-btn--ghost"
              onClick={() => void ask.refresh()}
            >
              Reconnect
            </button>
          </p>
        ) : null}
        <label className="ask-sr" htmlFor="ask-question">
          Ask a question
        </label>
        <div className="ask-input">
          <textarea
            id="ask-question"
            ref={composer}
            value={ask.draft}
            onChange={(event) => ask.setDraft(event.target.value)}
            maxLength={4000}
            rows={3}
            placeholder={
              ask.active
                ? "Wait for the answer or stop the current question"
                : "Ask a question about your data…"
            }
            aria-describedby="ask-composer-help"
            disabled={blocked}
            dir="auto"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (!blocked && ask.draft.trim()) {
                  nearBottom.current = true;
                  void ask.submit(data?.context);
                }
              }
            }}
          />
          <button
            className="gw-btn gw-btn--primary"
            type="submit"
            disabled={blocked || !ask.draft.trim()}
          >
            {ask.submitting ? "Sending…" : "Send"}
          </button>
        </div>
        <div className="ask-composer-help" id="ask-composer-help">
          <span>Enter to send · Shift+Enter for a new line</span>
          <span>{ask.draft.length}/4000</span>
        </div>
        <p className="ask-accuracy">
          Answers can be incomplete. Check the sources and time window.
        </p>
      </form>
    </div>
  );
}
