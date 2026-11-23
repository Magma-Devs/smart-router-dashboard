import type { McpReadResult, McpWindow } from "./mcp.js";

/** What the model is told beside a read the source narrowed. */
export const NARROWED_NOTE =
  "The source read part of what was asked. State the window this result covers, never the whole window asked for; read the next window the guidance names when the question needs the rest.";

const iso = (seconds: number) => {
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};
const span = (window: McpWindow) => ({ from: iso(window.start), to: iso(window.end) });

/**
 * A read the MCP server answered in part, or ran differently from what was
 * sent: the window it covers when that is known, and what the model is handed
 * with the data. Null for a read answered as asked.
 */
export function narrowedRead(result: McpReadResult): {
  partial: boolean;
  window?: McpWindow;
  fields: Record<string, unknown>;
} | null {
  if (!result.ok) return null;
  const partial = result.partial === true;
  if (!partial && !result.adjusted && !result.guidance) return null;
  return {
    partial,
    ...(partial && result.window ? { window: result.window.read } : {}),
    fields: {
      ...(partial
        ? {
            narrowed: result.window
              ? { asked: span(result.window.requested), read: span(result.window.read) }
              : true,
            note: NARROWED_NOTE,
          }
        : {}),
      ...(result.adjusted ? { ranAs: result.adjusted } : {}),
      ...(result.guidance ? { guidance: result.guidance } : {}),
    },
  };
}

/**
 * A read the MCP server did not answer, in the server's own terms: its code,
 * and its guidance when it gives one, so the model can change the read. Kept
 * short: a run's context holds eight of these beside the prompt.
 */
export function failedRead(result: McpReadResult): Record<string, unknown> {
  const code =
    typeof result.error === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(result.error)
      ? result.error
      : "READ_FAILED";
  return {
    error: `Read not answered: ${code}`,
    ...(result.guidance ? { guidance: result.guidance } : {}),
  };
}
