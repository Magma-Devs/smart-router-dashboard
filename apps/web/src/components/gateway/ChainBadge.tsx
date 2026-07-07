"use client";

import { useState } from "react";
import { buildChainMetaByIndex } from "@sr/shared";

/**
 * Chain icon, resolved by Lava spec index. Ported from lava-connect's
 * `<ChainIcon>`: renders the vendored brand SVG from public/chains/ on a
 * transparent ground (most chain SVGs carry their own brand color, so a
 * colored frame would hide the artwork). Falls back to a colored-letter
 * badge only when the image is missing or fails to load — including the
 * `default.svg` placeholder for chains with no vendored icon.
 *
 * Keeps the original `<ChainBadge spec size />` signature so every existing
 * call site works unchanged.
 */
export function ChainBadge({ spec, size = 26 }: { spec: string; size?: number }) {
  const chain = buildChainMetaByIndex(spec);
  const [errored, setErrored] = useState(false);

  if (errored) {
    const initial = (chain.name || spec || "?").charAt(0).toUpperCase();
    return (
      <div
        aria-hidden
        style={{
          width: size,
          height: size,
          borderRadius: 6,
          background: chain.color,
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          fontFamily: "var(--font-mono)",
          fontWeight: 700,
          fontSize: Math.round(size * 0.42),
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.18)",
        }}
      >
        {initial}
      </div>
    );
  }

  return (
    // Plain <img> — the SVGs are already size-appropriate and local, so
    // next/image optimisation would not help.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={chain.iconUrl}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size, objectFit: "contain", flexShrink: 0 }}
      onError={() => setErrored(true)}
    />
  );
}
