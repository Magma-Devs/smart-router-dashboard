/**
 * The request in focus on a log tab - the Transactions tab or the Errors
 * tab's request list - in the page's URL: `?request=<id>`. A link with it
 * opens the tab's look-up on that request, so it survives a reload and can be
 * shared. Opening a row, or finding a request by ID, writes it; closing them
 * clears it. It rewrites the entry it is on, as a change of tab does: opening
 * rows is not a history of its own. Picking another tab clears it.
 */
export const REQUEST_PARAM = "request";

/** The request the URL names; null when it names none, and on the server. */
export function requestFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(REQUEST_PARAM)?.trim() || null;
}

/** Name a request in the URL, or (null) none. */
export function linkRequest(id: string | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (id) url.searchParams.set(REQUEST_PARAM, id);
  else url.searchParams.delete(REQUEST_PARAM);
  if (url.href !== window.location.href) window.history.replaceState(null, "", url);
}
