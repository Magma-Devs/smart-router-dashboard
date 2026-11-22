import type { AskRun } from "@sr/shared";
import { finishedReads } from "./ask-display";

/** The reads a running answer has finished, under its status line. Nothing for
 * a run an API reports without progress. */
export function AskReads({ run }: { run: Pick<AskRun, "status" | "progress"> | null }) {
  const { shown, hidden } = finishedReads(run);
  if (!shown.length) return null;
  return (
    <ul className="ask-reads" aria-label="Data read so far">
      {hidden ? <li className="ask-reads-more">{hidden} earlier</li> : null}
      {shown.map((read, index) => (
        <li key={index} className={read.ok ? undefined : "ask-reads-failed"}>
          <span aria-hidden="true">{read.ok ? "✓" : "✕"}</span> {read.label}
          {read.ok ? null : <span className="ask-sr"> (unavailable)</span>}
        </li>
      ))}
    </ul>
  );
}
