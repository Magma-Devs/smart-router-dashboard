"use client";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import type { AskRun, AskRunDraft } from "@sr/shared";
import { askPoll } from "./ask-api";
import { runningDraft } from "./ask-display";
import { AskMarkdown } from "./AskMarkdown";
import { useAsk } from "./AskProvider";

/** How often a running answer's draft is read. */
export const DRAFT_POLL_MS = 500;

/**
 * The next text to show on the way to `target`: always a prefix of `target`
 * (a redacted value can rewrite text already shown), a step longer than what
 * is shown, shrinking as the gap closes, so a burst of words types in quickly
 * and a trickle reads evenly.
 */
export function revealStep(shown: string, target: string): string {
  const remaining = target.length - shown.length;
  if (remaining <= 0) return target;
  return target.slice(0, shown.length + Math.max(2, Math.ceil(remaining / 18)));
}

/** `target`, revealed a few characters a frame; at once for reduced motion. */
function useRevealed(target: string, animate: boolean): string {
  const [reduced] = useState(
    () =>
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  const live = animate && !reduced;
  const [shown, setShown] = useState("");
  const current = useRef("");
  useEffect(() => {
    if (!live) return;
    let frame = requestAnimationFrame(function tick() {
      const next = revealStep(current.current, target);
      current.current = next;
      setShown(next);
      if (next !== target) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, live]);
  return live ? shown : target;
}

/** The answer as the model writes it: Markdown with a caret, replaced by the
 * checked answer when it is saved. */
export function AskDraftView({ text, animate = true }: { text: string; animate?: boolean }) {
  const shown = useRevealed(text, animate);
  if (!text) return null;
  return (
    <article
      className="ask-answer ask-answer--streaming"
      aria-busy="true"
      aria-label="Reply in progress"
    >
      <AskMarkdown text={shown} streaming />
    </article>
  );
}

/**
 * A run's draft, read twice a second from the moment it is queued until its
 * status is final; a final status reloads the transcript at once, so the saved
 * answer replaces the draft without waiting for the slower run poll.
 */
export function AskDraft({ run }: { run: Pick<AskRun, "id" | "status" | "progress"> | null }) {
  const { api, refresh } = useAsk();
  const live = run?.status === "queued" || run?.status === "running";
  const settled = useRef<string | null>(null);
  const polled = useSWR<AskRunDraft>(
    live ? ["ask-draft", run.id] : null,
    () => api.get(`/api/ask/runs/${run!.id}/draft`),
    {
      ...askPoll<AskRunDraft>((data) =>
        data && data.status !== "queued" && data.status !== "running" ? 0 : DRAFT_POLL_MS,
      ),
      dedupingInterval: 0,
    },
  );
  const status = polled.data?.status;
  useEffect(() => {
    if (!run || !status || status === "queued" || status === "running") return;
    if (settled.current === run.id) return;
    settled.current = run.id;
    void refresh().catch(() => undefined);
  }, [run, status, refresh]);
  if (!live || (status && status !== "running")) return null;
  const draft = polled.data ? (polled.data.draft ?? "") : (runningDraft(run) ?? "");
  return <AskDraftView text={draft.trim()} />;
}
