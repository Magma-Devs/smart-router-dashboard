"use client";
import { useAsk } from "./AskProvider";
export function AskTrigger() {
  const ask = useAsk();
  if (!ask.visible) return null;
  return (
    <button
      className="gw-btn ask-trigger"
      onClick={() => void ask.open()}
      disabled={ask.loading}
      aria-expanded={ask.full || ask.mode === "panel"}
      title="Ask your data (⌘/Ctrl K)"
    >
      <span aria-hidden="true">✦</span>Ask your data
      {ask.active ? (
        <span className="ask-active-dot" aria-label="Question processing" />
      ) : (
        <kbd>⌘ K</kbd>
      )}
    </button>
  );
}
