"use client";
import { useEffect, useState } from "react";
import useSWRInfinite from "swr/infinite";
import type { AskChatPage } from "@sr/shared";
import { useAsk } from "./AskProvider";
import { groupHistory } from "./ask-display";
import { AskIcon } from "./AskIcon";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { useMe } from "@/hooks/use-me";

function ChatAccount() {
  const { me } = useMe();
  return (
    <div className="ask-account">
      <Link href="/account" aria-label="Your account">
        <span className="ask-account-avatar" aria-hidden="true">
          {(me?.name || me?.email || "A").slice(0, 1).toUpperCase()}
        </span>
        <span>{me?.name || "Your account"}</span>
      </Link>
      <button
        className="gw-btn gw-btn--ghost"
        aria-label="Sign out"
        title="Sign out"
        onClick={() => void signOut({ redirectTo: "/login" })}
      >
        <AskIcon name="logout" size={16} />
      </button>
    </div>
  );
}

export function AskHistory({
  onSelect,
  showAccount,
}: {
  onSelect?: () => void;
  showAccount?: boolean;
}) {
  const ask = useAsk();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const feed = useSWRInfinite<AskChatPage>(
    (index, previous: AskChatPage | null) =>
      !ask.available || (index > 0 && !previous?.nextCursor)
        ? null
        : ["ask", ask.scope, "history", query, index ? previous!.nextCursor : ""],
    ([, , , text, cursor]: [string, string, string, string, string]) =>
      ask.api.post("/api/ask/chats/search", {
        query: text,
        ...(cursor ? { cursor } : {}),
        limit: 20,
      }),
    { revalidateOnFocus: true, shouldRetryOnError: false },
  );
  const revalidateHistory = feed.mutate;
  useEffect(() => {
    void revalidateHistory();
  }, [ask.chatId, ask.active?.id, ask.active?.status, revalidateHistory]);
  const chats = [
    ...new Map(
      (feed.data ?? []).flatMap((page) => page.chats).map((chat) => [chat.id, chat]),
    ).values(),
  ];
  const groups = groupHistory(chats);
  return (
    <div className="ask-history">
      <div className="ask-history-top">
        <h2>Your chats</h2>
      </div>
      <button
        className="gw-btn ask-new-chat"
        onClick={() => {
          ask.select(null);
          onSelect?.();
        }}
      >
        <AskIcon name="plus" />
        <span>New chat</span>
      </button>
      <label className="ask-search">
        <AskIcon name="search" size={15} />
        <span className="ask-sr">Search your chats</span>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search your chats"
          maxLength={200}
        />
      </label>
      <div className="ask-history-list" aria-busy={feed.isLoading}>
        {feed.isLoading ? (
          <p className="ask-muted" role="status">
            Loading history…
          </p>
        ) : null}
        {feed.error ? (
          <div role="alert">
            <p>History couldn’t load.</p>
            <button className="gw-btn" onClick={() => void feed.mutate()}>
              Retry history
            </button>
          </div>
        ) : null}
        {!feed.isLoading && !feed.error && !chats.length ? (
          <p className="ask-muted">
            {query ? "No chats match this search." : "Your conversations will appear here."}
          </p>
        ) : null}
        {groups.map((group) => (
          <section key={group.label} aria-label={group.label}>
            <h3>{group.label}</h3>
            <ul>
              {group.chats.map((chat) => (
                <li key={chat.id}>
                  <button
                    aria-current={ask.chatId === chat.id ? "true" : undefined}
                    onClick={() => {
                      ask.select(chat.id);
                      onSelect?.();
                    }}
                    title={chat.title}
                    dir="auto"
                  >
                    {chat.title}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {feed.data?.at(-1)?.nextCursor ? (
          <button
            className="gw-btn ask-load-more"
            disabled={feed.isValidating}
            onClick={() => void feed.setSize(feed.size + 1)}
          >
            {feed.isValidating ? "Loading…" : "Load more chats"}
          </button>
        ) : null}
      </div>
      <p className="ask-private">
        <AskIcon name="lock" size={13} />
        Your chats are private to you.
      </p>
      {showAccount ? <ChatAccount /> : null}
    </div>
  );
}
