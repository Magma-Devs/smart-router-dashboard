/**
 * `DASHBOARD_NEW_UI` — whether the dashboard renders the screens 0.28.x
 * introduced, or the 0.27 ones.
 *
 * On (`true`): the Errors and Transactions tabs read from the router's logs,
 * the Failed requests card, the Upstreams deep-dive on one time axis, the
 * chains drawer with the chain and router in the URL, Upstreams grouped by
 * chain, and the tooltips with an arrow.
 *
 * Off (unset, or anything but `true`): the 0.27 screens, kept verbatim under
 * `src/legacy/` — the Traffic tab, the QoS and selection scores, the
 * Effective read p95 card, the Errors tab's Upstreams and Error types views,
 * and the router dropdown.
 *
 * A RUNTIME value, read from the container env per request by the root
 * layout (server) and handed down (`NewUiProvider`), so one published image
 * serves both and the page never draws one UI, then swaps to the other.
 * The api serves both: none of its routes changes with the flag.
 */
export function newUiEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.DASHBOARD_NEW_UI?.trim().toLowerCase() === "true";
}
