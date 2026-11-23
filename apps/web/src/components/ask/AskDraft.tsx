import type { AskRun } from "@sr/shared";
import { runningDraft } from "./ask-display";

/** The answer's summary while the model writes the rest. It is a draft: the
 * finished answer, checked against the data read, replaces it. Plain text. */
export function AskDraft({ run }: { run: Pick<AskRun, "status" | "progress"> | null }) {
  const draft = runningDraft(run);
  if (!draft) return null;
  return (
    <div className="ask-draft" aria-busy="true">
      <p dir="auto">{draft}</p>
      <small>Draft. The full answer replaces it once it is checked.</small>
    </div>
  );
}
