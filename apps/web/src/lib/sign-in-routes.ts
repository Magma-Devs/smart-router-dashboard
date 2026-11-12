/**
 * Which way each social button goes: straight to Google or GitHub, or through
 * a Dex broker (MAG-5238). Pure and env-driven so the login page, the
 * invitation page and the Auth.js config all read one answer — a button that
 * starts one flow while Auth.js registered another is a button that 404s.
 *
 * Per provider, Dex first: a provider listed in `DEX_CONNECTORS` while Dex is
 * configured goes through Dex; otherwise it goes direct when its own
 * `*_CLIENT_ID` + `*_CLIENT_SECRET` pair is set; otherwise it is not offered.
 * The fleet configures one or the other, never both — the chart refuses the
 * pair — and a self-run deployment keeps the direct pair it has today.
 */

export type ProviderId = "google" | "github";

/** How a provider's button reaches it. `null`: the button is not shown. */
export type ProviderRoute = "direct" | "dex";

export type ProviderRoutes = Record<ProviderId, ProviderRoute | null>;

export interface DexClient {
  issuer: string;
  clientId: string;
}

const PROVIDER_IDS: readonly ProviderId[] = ["google", "github"];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `DEX_ISSUER` + `DEX_CLIENT_ID`, or null. Both halves, and an https issuer
 * (plain http only on this machine) — the same rule the api applies, so the
 * web never offers a Dex button the api would refuse every token from.
 */
export function readDexClient(env: Record<string, string | undefined>): DexClient | null {
  const issuer = env.DEX_ISSUER?.trim() ?? "";
  const clientId = env.DEX_CLIENT_ID?.trim() ?? "";
  if (!issuer || !clientId) return null;
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return null;
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure || url.search || url.hash || url.username || url.password) return null;
  return { issuer, clientId };
}

/**
 * The providers Dex offers buttons for: `DEX_CONNECTORS`, a comma list of
 * `google` / `github`. Unset or empty means both. A name this dashboard does
 * not know is dropped rather than drawn as a button nobody can finish.
 */
export function readDexConnectors(env: Record<string, string | undefined>): ProviderId[] {
  const raw = env.DEX_CONNECTORS?.trim();
  if (!raw) return [...PROVIDER_IDS];
  const listed = new Set(raw.split(",").map((s) => s.trim().toLowerCase()));
  return PROVIDER_IDS.filter((id) => listed.has(id));
}

const DIRECT_PAIRS: Record<ProviderId, [string, string]> = {
  google: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  github: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
};

export function readProviderRoutes(env: Record<string, string | undefined>): ProviderRoutes {
  const viaDex = readDexClient(env) ? new Set(readDexConnectors(env)) : new Set<ProviderId>();
  const routeOf = (id: ProviderId): ProviderRoute | null => {
    if (viaDex.has(id)) return "dex";
    const [idVar, secretVar] = DIRECT_PAIRS[id];
    return env[idVar] && env[secretVar] ? "direct" : null;
  };
  return { google: routeOf("google"), github: routeOf("github") };
}

/** What `signIn` is called with for a provider's button. */
export interface SignInTarget {
  provider: string;
  /** Extra authorization-request parameters — Dex's `connector_id`, which
   *  sends the browser straight on to Google or GitHub instead of showing a
   *  Dex page to choose from. */
  params?: Record<string, string>;
}

export function signInTarget(id: ProviderId, routes: ProviderRoutes): SignInTarget {
  return routes[id] === "dex" ? { provider: "dex", params: { connector_id: id } } : { provider: id };
}

/**
 * The provider behind a Dex sign-in, from its ID token's `federated_claims`.
 * For display only — the code screen saying which account it is for. Whether
 * the token is anybody at all is the api's call, made against Dex's keys.
 */
export function dexConnectorOf(profile: unknown): ProviderId | null {
  const claims = (profile as { federated_claims?: { connector_id?: unknown } } | null | undefined)?.federated_claims;
  const id = claims?.connector_id;
  return id === "google" || id === "github" ? id : null;
}
