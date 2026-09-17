/**
 * Base URL for talking to the api from the server side of the web — Auth.js
 * callbacks and the first-run bootstrap read.
 *
 * Distinct from the browser-facing base in `lib/api-client.ts`: in docker
 * compose the api is `http://api:8000` from inside the web container while the
 * browser reaches the same service on `http://localhost:8000`. Resolved once,
 * at module load, because every input is a server env var.
 *
 * Kept free of `server-only` so `auth.config.ts` — which the edge proxy pulls
 * in — can share it.
 */
export const INTERNAL_API_BASE_URL =
  process.env.INTERNAL_API_BASE_URL ??
  process.env.DASHBOARD_API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:8000";
