import type { ReactNode } from "react";

type IconName =
  | "send"
  | "copy"
  | "check"
  | "search"
  | "plus"
  | "history"
  | "back"
  | "expand"
  | "minimize"
  | "close"
  | "sparkle"
  | "lock"
  | "logout";

const paths: Record<IconName, ReactNode> = {
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M9 12h12m-5-5 5 5-5 5" />
    </>
  ),
  send: <path d="M12 19V5m-6 6 6-6 6 6" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="3" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  history: (
    <>
      <path d="M3 11a9 9 0 1 1 2.5 7M3 4v7h7" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  back: <path d="m10 5-7 7 7 7M3 12h18" />,
  expand: (
    <>
      <path d="M14 3h7v7m0-7-7 7M10 21H3v-7m0 7 7-7" />
    </>
  ),
  minimize: <path d="M5 12h14" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  sparkle: <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" />,
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="3" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" />
    </>
  ),
};

export function AskIcon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
