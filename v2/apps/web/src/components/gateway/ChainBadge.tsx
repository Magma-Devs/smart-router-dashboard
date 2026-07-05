import { buildChainMetaByIndex } from "@sr/shared";

/* Ported from the design prototype (shell.jsx ChainBadge); resolves
   color/name via the spec-index map instead of the mock chainById. */

export function ChainBadge({ spec, size = 26 }: { spec: string; size?: number }) {
  const chain = buildChainMetaByIndex(spec);
  const initial = chain.name.slice(0, 1).toUpperCase();
  const fs = Math.round(size * 0.42);
  return (
    <div style={{
      width: size, height: size, borderRadius: 6, flexShrink: 0,
      background: chain.color, color: "#fff",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: fs,
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.18)",
    }}>{initial}</div>
  );
}
