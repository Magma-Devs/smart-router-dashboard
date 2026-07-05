/** Minimal inline icon set (stroke-based), matching the prototype's look. */
import { buildChainMetaByIndex } from "@sr/shared";

export type IconProps = {
  size?: number;
  className?: string;
  strokeWidth?: number;
  style?: React.CSSProperties;
};

function svg(path: React.ReactNode) {
  return function Icon({ size = 16, className, strokeWidth = 2, style }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        style={style}
      >
        {path}
      </svg>
    );
  };
}

export const IconHome = svg(
  <>
    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <polyline points="9 22 9 12 15 12 15 22" />
  </>,
);
export const IconPulse = svg(<polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />);
export const IconServer = svg(
  <>
    <rect x="2" y="2" width="20" height="8" rx="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" />
    <line x1="6" y1="6" x2="6.01" y2="6" />
    <line x1="6" y1="18" x2="6.01" y2="18" />
  </>,
);
export const IconGlobe = svg(
  <>
    <circle cx="12" cy="12" r="10" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </>,
);
export const IconChart = svg(
  <>
    <line x1="18" y1="20" x2="18" y2="10" />
    <line x1="12" y1="20" x2="12" y2="4" />
    <line x1="6" y1="20" x2="6" y2="14" />
  </>,
);
export const IconPlay = svg(<polygon points="5 3 19 12 5 21 5 3" />);
export const IconSun = svg(
  <>
    <circle cx="12" cy="12" r="5" />
    <line x1="12" y1="1" x2="12" y2="3" />
    <line x1="12" y1="21" x2="12" y2="23" />
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
    <line x1="1" y1="12" x2="3" y2="12" />
    <line x1="21" y1="12" x2="23" y2="12" />
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
  </>,
);
export const IconMoon = svg(<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />);
export const IconUsers = svg(
  <>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </>,
);
export const IconSettings = svg(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </>,
);

/* ── Chain brand logos ──────────────────────────────────────────────────
   Recognizable brand marks for the major chains. Each is self-colored.
   Ported verbatim from the design prototype (icons.jsx CHAIN_LOGOS). */
const CHAIN_LOGOS = {
  eth: (s: number) => (
    <svg width={s} height={s} viewBox="0 0 256 417" style={{ flexShrink: 0 }}>
      <path fill="#627EEA" d="M127.96 0 125.16 9.5v275.7l2.8 2.8 127.96-75.6z"/>
      <path fill="#8A92B2" d="M127.96 0 0 212.3l127.96 75.6V154.2z"/>
      <path fill="#627EEA" d="M127.96 312.19l-1.58 1.92v98.2l1.58 4.6L256 236.6z"/>
      <path fill="#8A92B2" d="M127.96 416.9v-104.7L0 236.6z"/>
      <path fill="#454A75" d="M127.96 287.9 256 212.3l-128.04-58.1z"/>
      <path fill="#62688F" d="M0 212.3l127.96 75.6V154.2z"/>
    </svg>
  ),
  poly: (s: number) => (
    <svg width={s} height={s} viewBox="0 0 38.4 33.5" style={{ flexShrink: 0 }}>
      <path fill="#8247E5" d="M29 10.2c-.7-.4-1.6-.4-2.4 0L21 13.5l-3.8 2.1-5.5 3.3c-.7.4-1.6.4-2.4 0L5 16.3c-.7-.4-1.2-1.2-1.2-2.1v-5c0-.8.4-1.6 1.2-2.1l4.3-2.5c.7-.4 1.6-.4 2.4 0L16 7.2c.7.4 1.2 1.2 1.2 2.1v3.3l3.8-2.2V7c0-.8-.4-1.6-1.2-2.1l-8-4.7c-.7-.4-1.6-.4-2.4 0L1.2 4.9C.4 5.4 0 6.2 0 7v9.4c0 .8.4 1.6 1.2 2.1l8.1 4.7c.7.4 1.6.4 2.4 0l5.5-3.2 3.8-2.2 5.5-3.2c.7-.4 1.6-.4 2.4 0l4.3 2.5c.7.4 1.2 1.2 1.2 2.1v5c0 .8-.4 1.6-1.2 2.1L34 30.6c-.7.4-1.6.4-2.4 0l-4.3-2.5c-.7-.4-1.2-1.2-1.2-2.1v-3.3l-3.8 2.2v3.3c0 .8.4 1.6 1.2 2.1l8.1 4.7c.7.4 1.6.4 2.4 0l8.1-4.7c.7-.4 1.2-1.2 1.2-2.1V17c0-.8-.4-1.6-1.2-2.1L29 10.2z"/>
    </svg>
  ),
  base: (s: number) => (
    <svg width={s} height={s} viewBox="0 0 111 111" style={{ flexShrink: 0 }}>
      <path fill="#0052FF" d="M54.9 110.8C85.6 110.8 110.5 86 110.5 55.4 110.5 24.8 85.6 0 54.9 0 25.8 0 1.9 22.3 0 50.7h73.5v9.4H0c1.9 28.4 25.8 50.7 54.9 50.7z"/>
    </svg>
  ),
  optm: (s: number) => (
    <svg width={s} height={s} viewBox="0 0 500 500" style={{ flexShrink: 0 }}>
      <circle cx="250" cy="250" r="250" fill="#FF0420"/>
      <path fill="#fff" d="M177 316c-19 0-34-4.5-46-13.5-11-9-17-22-17-39 0-3.5.5-8 1-13 1.5-9 4-19.5 7-32 9-36 32-54 69-54 10 0 19 1.5 27 5 8 3.5 14.5 8.5 19 15.5 4.5 7 7 15 7 25 0 3.5-.5 7.5-1 12.5-1.5 11-4 21.5-7 31.5-4.5 18-12.5 31.5-23.5 40.5-11 9-25.5 13.5-43.5 13.5h-14zm6-37c7 0 13-2 18-6.5 5-4.5 8.5-11 10.5-19.5 3-12 5-21 5.5-27 .5-2.5.5-5 .5-7.5 0-10-5-15-15.5-15-7 0-13 2-18 6.5-5 4.5-8.5 11-10.5 19.5-2.5 9.5-4.5 18.5-5.5 27-.5 2.5-.5 5-.5 7 0 10.5 5.5 15.5 15.5 15.5zm71 35c-1 0-1.5-.5-2-1-.5-.5-.5-1.5-.5-2.5l30-141c.5-2 1.5-3 3.5-3h57c16 0 28.5 3.5 38 10 9.5 6.5 14.5 16 14.5 28.5 0 3.5-.5 7.5-1.5 11.5-3.5 16-10.5 28-21.5 35.5-11 7.5-26 11.5-45 11.5h-29l-10 47c-.5 2-1.5 3-3.5 3h-31zm75-80c6 0 11.5-1.5 16-5 4.5-3.5 7.5-8.5 9-15 .5-2.5.5-4.5.5-6.5 0-4-1-7-3.5-9-2.5-2-6-3-11-3h-26l-9 41h33z"/>
    </svg>
  ),
  bsc: (s: number) => (
    <svg width={s} height={s} viewBox="0 0 32 32" style={{ flexShrink: 0 }}>
      <path fill="#F0B90B" d="M16 0l4.94 5.06-7.06 7.06L8.94 7.12 16 0zm7.06 7.06L28 12l-4.94 4.94L18.12 12l4.94-4.94zM8.94 12L16 19.06 23.06 12 16 4.94 8.94 12zm-1.88-4.94L12 12l-4.94 4.94L2.12 12l4.94-4.94zM16 19.06L20.94 24 16 28.94 11.06 24 16 19.06z"/>
      <path fill="#F0B90B" d="M16 12l2.5 2.56L16 17.12 13.5 14.56 16 12z"/>
    </svg>
  ),
  arb: (s: number) => (
    <svg width={s} height={s} viewBox="0 0 250 250" style={{ flexShrink: 0 }}>
      <circle cx="125" cy="125" r="125" fill="#2D374B"/>
      <path fill="#28A0F0" d="M125 18l85 49v98l-85 49-85-49V67l85-49zm-8 60l-38 96h18l8-21h41l8 21h18l-39-96h-16zm8 24l14 36h-28l14-36z"/>
    </svg>
  ),
};

/** Map a Prometheus `spec` label onto a brand-logo key (uppercase-prefix match). */
function chainLogoKey(spec: string): keyof typeof CHAIN_LOGOS | null {
  const u = spec.toUpperCase();
  if (u.startsWith("ETH")) return "eth";
  if (u.startsWith("POLYGON")) return "poly";
  if (u.startsWith("BASE")) return "base";
  if (u.startsWith("OPTM") || u.startsWith("OPTIMISM")) return "optm";
  if (u.startsWith("BSC")) return "bsc";
  if (u.startsWith("ARB")) return "arb";
  return null;
}

export function ChainLogo({ spec, size = 16 }: { spec: string; size?: number }) {
  const key = chainLogoKey(spec);
  if (key) return CHAIN_LOGOS[key](size);
  const ch = buildChainMetaByIndex(spec);
  return (
    <span style={{ width: size, height: size, borderRadius: 5, background: ch.color, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: Math.round(size * 0.55), fontWeight: 700, flexShrink: 0 }}>
      {ch.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function MagmaLogo({ size = 28 }: { size?: number }) {
  // The orange-gradient Magma mark (PNG ships in /public).
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src="/magma-logo.png"
      width={size}
      height={size}
      alt="Magma"
      style={{ flexShrink: 0, display: "block", objectFit: "contain" }}
    />
  );
}
