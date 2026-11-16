import { Auth, type AuthConfig } from "@auth/core";
import GitHub from "@auth/core/providers/github";
import Google from "@auth/core/providers/google";

/**
 * The dashboards' sign-in redirect proxy.
 *
 * A dashboard with `AUTH_REDIRECT_PROXY_URL` set names THIS proxy's callback
 * to Google (or GitHub) as the redirect URI and carries its own callback inside
 * the signed `state`. The provider sends the browser here; Auth.js, configured
 * with its own URL as the proxy, decodes the `state` with the shared
 * `AUTH_SECRET` and answers a redirect to the dashboard's callback with the
 * original query. The dashboard then finishes the sign-in exactly as it does
 * when it is its own callback. Nothing here exchanges a code, reads a profile
 * or holds a client secret.
 *
 * What this adds to Auth.js's own behaviour is the allowlist: a `state` signed
 * with the right secret could name any origin, so the answer is checked before
 * it leaves. Only `https://<CALLBACK_HOST_PATTERN>/api/auth/callback/<the same
 * provider>` is forwarded; everything else, Auth.js's own error redirects
 * included, is a 400 with no Location.
 */
export interface ProxyEnv {
  /** Shared with every dashboard behind the proxy: what signs their `state`. */
  AUTH_SECRET: string;
  /** This proxy's own base URL, `https://<host>/api/auth`. */
  AUTH_REDIRECT_PROXY_URL: string;
  /** A regular expression the destination hostname must match in full. */
  CALLBACK_HOST_PATTERN: string;
  /** The fleet's Google client id; absent, Google callbacks are not served. */
  GOOGLE_CLIENT_ID?: string;
  /** The fleet's GitHub app id; absent, GitHub callbacks are not served. */
  GITHUB_CLIENT_ID?: string;
}

const PROVIDERS = ["google", "github"] as const;
type ProviderId = (typeof PROVIDERS)[number];

export function proxyConfig(env: ProxyEnv): AuthConfig {
  const proxy = new URL(env.AUTH_REDIRECT_PROXY_URL);
  const providers: AuthConfig["providers"] = [];
  // A client id and nothing else: the provider has to be registered for Auth.js
  // to route `/callback/<id>`, and the proxy branch runs before any exchange.
  if (env.GOOGLE_CLIENT_ID) providers.push(Google({ clientId: env.GOOGLE_CLIENT_ID }));
  if (env.GITHUB_CLIENT_ID) providers.push(GitHub({ clientId: env.GITHUB_CLIENT_ID }));
  return {
    secret: env.AUTH_SECRET,
    trustHost: true,
    basePath: proxy.pathname,
    // Its own URL: this is what makes Auth.js read the `state` for an origin
    // to send the browser on to, instead of treating the callback as its own.
    redirectProxyUrl: env.AUTH_REDIRECT_PROXY_URL,
    providers,
  };
}

function providerOf(pathname: string, basePath: string): ProviderId | null {
  const prefix = `${basePath}/callback/`;
  if (!pathname.startsWith(prefix)) return null;
  const id = pathname.slice(prefix.length);
  return (PROVIDERS as readonly string[]).includes(id) ? (id as ProviderId) : null;
}

export async function handle(request: Request, env: ProxyEnv): Promise<Response> {
  const url = new URL(request.url);
  const proxy = new URL(env.AUTH_REDIRECT_PROXY_URL);
  const provider = providerOf(url.pathname, proxy.pathname);
  if (!provider) return new Response("Not Found", { status: 404 });
  if (request.method !== "GET")
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });

  const answer = await Auth(request, proxyConfig(env));
  const location = answer.headers.get("location");
  const target = location ? safeUrl(location, url) : null;
  const forwarded =
    answer.status >= 300 &&
    answer.status < 400 &&
    target !== null &&
    target.protocol === "https:" &&
    new RegExp(env.CALLBACK_HOST_PATTERN).test(target.hostname) &&
    target.pathname === `${proxy.pathname}/callback/${provider}`;

  if (!forwarded) {
    console.log(
      JSON.stringify({
        event: "auth-proxy.refused",
        provider,
        status: answer.status,
        host: target?.hostname ?? null,
      }),
    );
    return new Response("Bad Request", { status: 400, headers: { "cache-control": "no-store" } });
  }
  console.log(JSON.stringify({ event: "auth-proxy.forwarded", provider, host: target.hostname }));
  return new Response(null, {
    status: 302,
    headers: {
      location: target.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

function safeUrl(value: string, base: URL): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}
