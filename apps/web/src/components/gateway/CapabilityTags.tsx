/**
 * Capability chips for an upstream / endpoint: the addons + extensions the
 * mounted config declares (archive, debug, trace) plus a derived WS tag when
 * a websocket transport is configured. Honest-data: renders nothing when the
 * config declares no capabilities — never invents them.
 *
 * Addons come from the config parser's per-node `addons: [...]` (helm-values)
 * / node-url `addons` (SR_CONFIG); the router's own capability vocabulary.
 */

const CAP_META: Record<string, { label: string; color: string; title: string }> = {
  archive: { label: "archive", color: "#a78bfa", title: "Serves historical/archive state" },
  debug: { label: "debug", color: "#f472b6", title: "debug_* namespace enabled" },
  trace: { label: "trace", color: "#fbbf24", title: "trace_* namespace enabled" },
  ws: { label: "ws", color: "#34d399", title: "WebSocket transport configured (subscriptions)" },
};

/** Order chips consistently regardless of config order. */
const CAP_ORDER = ["archive", "debug", "trace", "ws"];

/** Derive the capability set from a node's addons + whether a ws transport
 *  is present (ws:// / wss:// url or a *-ws interface). */
export function capabilitiesOf(opts: {
  addons?: string[];
  hasWs?: boolean;
}): string[] {
  const set = new Set<string>();
  for (const a of opts.addons ?? []) {
    const k = a.toLowerCase();
    if (k in CAP_META) set.add(k);
  }
  if (opts.hasWs) set.add("ws");
  return CAP_ORDER.filter((c) => set.has(c));
}

export function CapabilityTags({
  capabilities,
  size = "sm",
}: {
  capabilities: string[];
  size?: "sm" | "xs";
}) {
  if (capabilities.length === 0) return null;
  const fs = size === "xs" ? 9 : 10;
  const pad = size === "xs" ? "1px 5px" : "2px 6px";
  return (
    <span style={{ display: "inline-flex", gap: 4, flexShrink: 0 }}>
      {capabilities.map((c) => {
        const m = CAP_META[c]!;
        return (
          <span
            key={c}
            title={m.title}
            style={{
              // Extensions/addons read as MODIFIERS on the interface, so they use
              // an outlined (bordered, transparent-fill) style — visually distinct
              // from the solid-tint interface-type tag next to them.
              fontSize: fs,
              fontWeight: 600,
              padding: pad,
              borderRadius: 999,
              background: "transparent",
              border: "1px solid " + m.color + "66",
              color: m.color,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              lineHeight: 1.4,
            }}
          >
            {m.label}
          </span>
        );
      })}
    </span>
  );
}
