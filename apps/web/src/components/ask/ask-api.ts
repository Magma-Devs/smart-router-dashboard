import { apiGet, apiPost, apiSend } from "@/lib/api-client";

/** The token is only a browser's existing dashboard session. This binding is
 * not authorization; the API still verifies the current session and ownership. */
export function createAskApi(sessionToken: string) {
  return {
    get: <T>(path: string) => apiGet<T>(path, sessionToken),
    post: <T>(path: string, body: unknown) => apiPost<T>(path, body, sessionToken),
    send: <T>(method: "PATCH", path: string, body: unknown) =>
      apiSend<T>(method, path, body, sessionToken),
  };
}
