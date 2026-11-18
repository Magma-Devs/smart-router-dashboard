"use client";
import { useEffect, useRef, useState } from "react";
import type { AskAnswer as Answer } from "@sr/shared";
import { answerText } from "./ask-display";
import { AskIcon } from "./AskIcon";

export function AskTime({ value }: { value: string }) {
  return (
    <time dateTime={value} title={value}>
      {new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
    </time>
  );
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
  const partial = answer.evidence.some(
    (item) => item.truncated || ["partial", "unavailable"].includes(item.coverage),
  );
  return (
    <article className="ask-answer" aria-label="Answer" data-ask-message={messageId}>
      <div className="ask-assistant-label">
        <span className="ask-avatar">
          <AskIcon name="sparkle" size={17} />
        </span>
        <span>Smart Router</span>
      </div>
      <p className="ask-summary" dir="auto">
        {answer.summary}
      </p>
      <ol className="ask-sections">
        {answer.sections.map((section, i) => (
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
      {partial ? (
        <p className="ask-coverage-warning">
          Some sources returned partial, truncated or unavailable data. Check the evidence before
          drawing conclusions.
        </p>
      ) : null}
      <details className="ask-evidence">
        <summary>Sources and time window · {answer.evidence.length}</summary>
        {answer.evidence.length ? (
          <ul>
            {answer.evidence.map((item) => (
              <li key={item.id}>
                <div>
                  <code>{item.sourceId}</code>
                  <span className={`ask-coverage ask-coverage--${item.coverage}`}>
                    {item.truncated
                      ? "Truncated"
                      : item.coverage === "unknown"
                        ? "Coverage not confirmed"
                        : item.coverage}
                  </span>
                </div>
                <code>{item.operationId}</code>
                <div>
                  {item.from ? (
                    <>
                      <AskTime value={item.from} />
                      {item.to ? (
                        <>
                          {" "}
                          — <AskTime value={item.to} />
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
        ) : (
          <p>No source evidence was recorded.</p>
        )}
      </details>
      <div className="ask-answer-actions">
        <CopyAnswer answer={answer} />
        <AskTime value={answer.answeredAt} />
      </div>
    </article>
  );
}
