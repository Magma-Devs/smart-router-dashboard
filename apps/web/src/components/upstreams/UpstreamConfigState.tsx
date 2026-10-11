import type { RouterConfiguration } from "@sr/shared";

const failures = {
  missing: [
    "Router configuration is not connected",
    "The dashboard cannot find the router configuration file.",
  ],
  unreadable: [
    "Router configuration cannot be read",
    "Check that the configuration file is mounted and the dashboard API has permission to read it.",
  ],
  invalid: [
    "Router configuration is invalid",
    "The mounted file contains invalid YAML or an invalid configuration structure.",
  ],
  unsupported: [
    "Router configuration format is not supported",
    "Use the router's native YAML (direct-rpc or backup-direct-rpc) or Helm values (routers).",
  ],
} as const;

/** Shared by both dashboard versions. Never render raw API/parser errors. */
export function UpstreamConfigState({
  configuration,
  error,
  loading,
  emptyKind,
}: {
  configuration?: RouterConfiguration["configuration"];
  error: boolean;
  loading: boolean;
  emptyKind: "routers" | "upstreams";
}) {
  if (loading)
    return (
      <div className="gw-empty" role="status">
        Loading upstream configuration…
      </div>
    );
  if (error)
    return (
      <div className="gw-empty" role="alert">
        <h2>Unable to load upstream configuration</h2>
        <p>
          The dashboard API could not be reached or returned an error. Check the connection and use
          Refresh to try again.
        </p>
      </div>
    );
  if (configuration?.status === "loaded")
    return (
      <div className="gw-empty" role="status">
        <h2>{emptyKind === "routers" ? "No routers configured" : "No upstreams configured"}</h2>
        <p>
          The router configuration was loaded successfully, but contains no{" "}
          {emptyKind === "routers" ? "routers" : "upstream endpoints"} to display. Check the
          configuration used by the running router.
        </p>
      </div>
    );
  const [title, detail] = configuration
    ? failures[configuration.status]
    : [
        "No upstream configuration available",
        "Check that the dashboard can read the configuration used by the running router.",
      ];
  return (
    <div className="gw-empty" role="status">
      <h2>{title}</h2>
      <p>{detail} Metrics can still be available without this file.</p>
      <p>
        Docker Compose is supported; Kubernetes is not required. Connect the same configuration file
        used by your router to the dashboard API.
      </p>
      <a
        className="gw-btn"
        href="https://github.com/Magma-Devs/smart-router-dashboard/blob/main/README.md#router-configuration-for-docker-compose"
        target="_blank"
        rel="noreferrer"
      >
        View configuration setup
      </a>
    </div>
  );
}
