"use client";
import { useEffect, useRef, useState } from "react";
import type { AskAnswer as Answer } from "@sr/shared";
import { answerSections, answerText } from "./ask-display";
import { AskIcon } from "./AskIcon";
import { LocalTime } from "@/components/gateway/LocalTime";

/** A time in the dashboard's one format: today's as a time, an older one with its day. */
export function AskTime({ value }: { value: string }) {
  const today = new Date(value).toDateString() === new Date().toDateString();
  return <LocalTime t={value} format={today ? "time" : "dayTime"} />;
}
/** What a read was of, in a word: the operation ids are the data service's own. */
function sourceKind(operationId: string): string {
  return operationId.startsWith("logs.")
    ? "Logs"
    : operationId.startsWith("metrics.")
      ? "Metrics"
      : "Data";
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
  const partial = answer.evidence.some(
    (item) => item.truncated || ["partial", "unavailable"].includes(item.coverage),
  );
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
                    <strong>{sourceKind(item.operationId)}</strong>{" "}
                    <code title={item.operationId}>{item.sourceId}</code>
                  </span>
                  {item.truncated || ["partial", "unavailable"].includes(item.coverage) ? (
                    <span className={`ask-coverage ask-coverage--${item.coverage}`}>
                      {item.truncated ? "Cut short" : item.coverage}
                    </span>
                  ) : null}
                </div>
                <div>
                  {item.from ? (
                    <>
                      <AskTime value={item.from} />
                      {item.to ? (
                        <>
                          {" "}
                          to <AskTime value={item.to} />
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
