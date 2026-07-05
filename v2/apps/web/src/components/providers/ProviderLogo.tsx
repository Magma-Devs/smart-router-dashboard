"use client";

import { useState } from "react";
import { PROVIDER_COLORS, PROVIDER_DOMAINS } from "@/components/providers/catalog";

/* Ported verbatim from the design prototype (page-providers.jsx ProviderLogo):
 * Clearbit favicon with an SVG server-icon fallback. Deliberately a plain
 * <img> with onError fallback — NOT next/image (external host, no loader). */

export function ProviderLogo({ id, size = 28 }: { id?: string | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  const domain = id ? PROVIDER_DOMAINS[id] : undefined;
  const color = id ? PROVIDER_COLORS[id] : undefined;
  const r = Math.round(size * 0.28);

  if (!domain || failed) {
    /* Generic server icon */
    return (
      <div style={{ width: size, height: size, borderRadius: r, background: color || "var(--surface-2)",
        border: color ? "none" : "1px solid var(--line)", display: "flex", alignItems: "center",
        justifyContent: "center", flexShrink: 0, overflow: "hidden" }}>
        <svg width={size * 0.52} height={size * 0.52} viewBox="0 0 24 24" fill="none"
          stroke="rgba(255,255,255,0.9)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/>
          <line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>
        </svg>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://logo.clearbit.com/${domain}`}
      width={size} height={size}
      alt={id ?? "provider"}
      onError={() => setFailed(true)}
      style={{ borderRadius: r, flexShrink: 0, display: "block", objectFit: "cover",
        background: "var(--surface-2)" }}
    />
  );
}
