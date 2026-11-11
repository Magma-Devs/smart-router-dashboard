/**
 * Links into the Grafana logs board ("Smart Router Dashboard Logs"). Its
 * variables: `var-service` (router) and `var-search`, a regex its Logs panel
 * filters the lines by. The page's "View full logs" opens it on the page's
 * window and chain; a log row's "Logs" opens it on one request.
 */

/** A request's lines can land this long before its start or after its end. */
export const REQUEST_LOGS_PAD_MS = 60_000;

/**
 * The board's URL. `from` / `to` are Grafana times: `now-3600s` and `now`, or
 * unix ms. `refresh` keeps a live view polling; an exact range doesn't need it.
 */
export function logsBoardHref(
  grafanaBase: string,
  { search, from, to, refresh }: { search: string; from: string | number; to: string | number; refresh?: string },
): string {
  const params = new URLSearchParams({
    orgId: "1",
    from: String(from),
    to: String(to),
    timezone: "browser",
    "var-service": "router",
    "var-search": search,
    ...(refresh ? { refresh } : {}),
  });
  return `${grafanaBase.replace(/\/$/, "")}/?${params.toString()}`;
}

/**
 * One request's lines: its ID is the search, and the range runs from a minute
 * before it started to a minute after it ended - `tookMs` after the start,
 * or the start alone when its end isn't known.
 */
export function requestLogsHref(grafanaBase: string, id: string, startMs: number, tookMs: number | null): string {
  const endMs = startMs + Math.max(0, tookMs ?? 0);
  return logsBoardHref(grafanaBase, {
    search: id,
    from: Math.floor(startMs - REQUEST_LOGS_PAD_MS),
    to: Math.ceil(endMs + REQUEST_LOGS_PAD_MS),
  });
}
