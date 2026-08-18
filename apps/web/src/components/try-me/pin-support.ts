/**
 * Can the router be told which upstream to use?
 *
 * `lava-select-provider` is checked against the router's PRIMARY pool and
 * nothing else (`getValidProviderAddresses`, smart-router
 * `protocol/lavasession/consumer_session_manager.go`). A backup-tier provider
 * lives in a separate pool the router reaches only once every primary is
 * exhausted, and it picks among those by QoS through the optimizer — the
 * header is never read on that path. So a pinned request naming a backup
 * cannot arrive, whatever the upstream's health:
 *
 *   -32000 Selected provider not available … {selectedProvider:blockdaemon,
 *   validProviders:tatum}
 *
 * The drawer needs that as a fact, not as a failed request. Kept pure and
 * apart from the drawer so it can be tested and so both surfaces that pin
 * (Try-me and the Test-connection modal) read one answer.
 */

/** Which pool the values file puts this endpoint in. */
export type UpstreamTier = "primary" | "backup";

/** Why the router can't be pinned to this upstream — one sentence, shown as
 *  is. Null when it can. */
export function pinRefusalFor(tier: UpstreamTier): string | null {
  if (tier !== "backup") return null;
  return "This upstream is configured as a backup: the router routes to backups only after every primary upstream is exhausted, and picks among them itself. A pinned request can't reach it — the router answers -32000 Selected provider not available.";
}

/** Whether the router honours a pin naming this upstream. */
export function isPinnable(tier: UpstreamTier): boolean {
  return pinRefusalFor(tier) === null;
}

/**
 * Which path the drawer opens on. Backups open on the direct leg when the api
 * can dial one: it is the only path that reaches a backup, so opening on a
 * pin that cannot work would make the reader run a request to learn what the
 * config already says.
 */
export function initialTargetFor(args: {
  tier: UpstreamTier;
  /** Whether this row has an upstream endpoint the api can dial. */
  directAvailable: boolean;
}): "router" | "upstream" {
  return !isPinnable(args.tier) && args.directAvailable ? "upstream" : "router";
}
