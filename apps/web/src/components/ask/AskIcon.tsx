import type { ReactNode } from "react";

type IconName =
  | "send"
  | "copy"
  | "check"
  | "search"
  | "plus"
  | "history"
  | "back"
  | "lock"
  | "sources"
  | "alert"
  | "retry"
  | "edit";

const paths: Record<IconName, ReactNode> = {
  send: <path d="M12 19V5m-6 6 6-6 6 6" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="3" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5m0 3.2v.3" />
    </>
  ),
  retry: <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16v4Zm9-13 4 4" />,
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
  sources: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
    </>
  ),
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
