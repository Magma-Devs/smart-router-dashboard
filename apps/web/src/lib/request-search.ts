/**
 * The top bar's "Find a request" box, on every page: where it sends you.
 *
 * A request is looked up on the Metrics page's "Find a request" tab
 * (`?tab=request&request=<id>`, `lib/request-in-url.ts`), with the chain and
 * router in view carried along, so the tab opens where the reader was
 * looking. Already on the Metrics page, the URL is pushed and the page told
 * (a `popstate`, which `useScopeInUrl` and the tab both listen to), so Back
 * returns to the view before the search; from any other page it is an
 * ordinary navigation.
 */
export const METRICS_PATH = "/metrics";
export const REQUEST_TAB = "request";

/** The Metrics page URL that opens the look-up on `id`, in the chain and router given. */
export function requestSearchUrl(id: string, scope: { chain: string | null; router: string | null }): string {
  const q = new URLSearchParams();
  if (scope.chain) q.set("chain", scope.chain);
  if (scope.router) q.set("router", scope.router);
  q.set("tab", REQUEST_TAB);
  q.set("request", id.trim());
  return `${METRICS_PATH}?${q.toString()}`;
}

/** Open the look-up on `id`: in place on the Metrics page, else by navigating there. */
export function openRequestSearch(
  id: string,
  scope: { chain: string | null; router: string | null },
  pathname: string,
  push: (url: string) => void,
): void {
  const url = requestSearchUrl(id, scope);
  if (pathname === METRICS_PATH && typeof window !== "undefined") {
    window.history.pushState(null, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
    return;
  }
  push(url);
}
