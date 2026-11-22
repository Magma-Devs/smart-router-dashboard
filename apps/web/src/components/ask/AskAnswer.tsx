"use client";
import { useEffect, useRef, useState } from "react";
import type { AskAnswer as Answer } from "@sr/shared";
import {
  answerHasGap,
  answerSections,
  answerText,
  evidenceBadges,
  evidenceSourceLabel,
  windowSpansDays,
} from "./ask-display";
import { AskIcon } from "./AskIcon";
import { LocalTime } from "@/components/gateway/LocalTime";

/** A time in the dashboard's one format: today's as a time, an older one with
 * its day. `withDay` shows the day on today's too. */
export function AskTime({ value, withDay = false }: { value: string; withDay?: boolean }) {
  const today = new Date(value).toDateString() === new Date().toDateString();
  return <LocalTime t={value} format={today && !withDay ? "time" : "dayTime"} />;
}
function CopyAnswer({ answer }: { answer: Answer }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <div className="ask-copy">
      <button
        className="gw-btn gw-btn--ghost"
        aria-label={status === "copied" ? "Copied" : "Copy answer"}
        title={status === "copied" ? "Copied" : "Copy answer"}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(answerText(answer));
            setStatus("copied");
          } catch {
            setStatus("failed");
          }
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setStatus("idle"), 2500);
        }}
      >
        <AskIcon name={status === "copied" ? "check" : "copy"} size={14} />
        <span>{status === "copied" ? "Copied" : "Copy"}</span>
      </button>
      <span className="ask-sr" role="status">
        {status === "copied"
          ? "Answer copied"
          : status === "failed"
            ? "Copy failed. Select the answer text and copy it manually."
            : ""}
      </span>
      {status === "failed" ? <small>Couldn’t copy. Select the text to copy it.</small> : null}
    </div>
  );
}
export function AskAnswer({ answer, messageId }: { answer: Answer; messageId?: string }) {
  const sections = answerSections(answer);
  const partial = answerHasGap(answer);
  return (
    <article className="ask-answer" aria-label="Answer" data-ask-message={messageId}>
      <p className="ask-summary" dir="auto">
        {answer.summary}
      </p>
      {sections.length ? (
        <ol className="ask-sections">
          {sections.map((section, i) => (
            <li key={i}>
              <h3 dir="auto">{section.title}</h3>
              <p dir="auto">{section.body}</p>
              {section.points?.length ? (
                <ul>
                  {section.points.map((point, j) => (
                    <li key={j} dir="auto">
                      {point}
                    </li>
                  ))}
                </ul>
              ) : null}
              {section.stat ? (
                <div className={`ask-stat ask-stat--${section.stat.tone}`}>
                  <strong dir="auto">{section.stat.value}</strong>
                  <span dir="auto">{section.stat.label}</span>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {partial ? (
        <p className="ask-coverage-warning">
          Some of the data behind this answer was missing or cut short. Check the sources below.
        </p>
      ) : null}
      {answer.evidence.length ? (
        <details className="ask-evidence">
          <summary>Sources and time window · {answer.evidence.length}</summary>
          <ul>
            {answer.evidence.map((item) => (
              <li key={item.id}>
                <div>
                  <span>
                    <strong>{evidenceSourceLabel(item.operationId)}</strong>
                  </span>
                  <span className="ask-coverage-badges">
                    {evidenceBadges(item).map((badge) => (
                      <span
                        key={badge.label}
                        className={`ask-coverage ask-coverage--${badge.tone}`}
                        title={badge.title}
                      >
                        {badge.label}
                      </span>
                    ))}
                  </span>
                </div>
                <div>
                  {item.from ? (
                    <>
                      <AskTime value={item.from} withDay={windowSpansDays(item.from, item.to)} />
                      {item.to ? (
                        <>
                          {" "}
                          to{" "}
                          <AskTime value={item.to} withDay={windowSpansDays(item.from, item.to)} />
                        </>
                      ) : null}
                    </>
                  ) : (
                    <>
                      Observed <AskTime value={item.observedAt} />
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="ask-answer-actions">
        <CopyAnswer answer={answer} />
        <AskTime value={answer.answeredAt} />
      </div>
    </article>
  );
}
