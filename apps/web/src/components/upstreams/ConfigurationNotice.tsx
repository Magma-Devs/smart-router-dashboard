"use client";

import type { RouterConfigurationState } from "@sr/shared";

type NoticeStatus =
  Exclude<RouterConfigurationState["status"], "ready" | "empty"> | "loading" | "request-error";

const notices: Record<NoticeStatus, { title: string; message: string }> = {
  loading: {
    title: "Loading router configuration",
    message: "Reading the configured chains and upstreams.",
  },
  missing: {
    title: "Router configuration is missing",
    message:
      "The dashboard cannot find the router configuration. Connect the same configuration used by your router, then try again.",
  },
  unreadable: {
    title: "Router configuration is not readable",
    message:
      "The dashboard does not have permission to read the router configuration. Your router may still be serving requests. Grant the dashboard read access, then try again.",
  },
  invalid: {
    title: "Router configuration is invalid",
    message:
      "The configuration must be a valid YAML file containing router or Helm values. Correct the file, then try again.",
  },
  unsupported: {
    title: "Router configuration format is unsupported",
    message:
      "The dashboard supports Smart Router configuration and Helm values. Connect a configuration in one of these formats, then try again.",
  },
  error: {
    title: "Unable to read router configuration",
    message:
      "The dashboard could not load the configured chains and upstreams. Check the configuration connection, then try again.",
  },
  "request-error": {
    title: "Unable to load router configuration",
    message:
      "The dashboard could not retrieve the configuration from its API. Check the connection, then try again.",
  },
};

export function ConfigurationNotice({
  status,
  onRetry,
  busy,
}: {
  status: NoticeStatus;
  onRetry: () => void;
  busy: boolean;
}) {
  const notice = notices[status];
  return (
    <div className="gw-empty" role={status === "loading" ? "status" : "alert"}>
      <h2>{notice.title}</h2>
      <p>{notice.message}</p>
      {status !== "loading" && (
        <button type="button" className="gw-btn gw-btn--ghost" onClick={onRetry} disabled={busy}>
          {busy ? "Checking configuration…" : "Try again"}
        </button>
      )}
    </div>
  );
}
