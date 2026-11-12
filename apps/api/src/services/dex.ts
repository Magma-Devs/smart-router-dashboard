import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { readDexConfig } from "../config.js";
import type { OAuthProfile, OAuthProvider } from "./users.js";

/**
 * Verifying a sign-in that came through a Dex broker (MAG-5238).
 *
 * With Dex in front, Google and GitHub talk to Dex, and the dashboard gets an
 * ID token Dex signed. The web hands that token here, exactly as it hands over
 * Google's or GitHub's today, and the api checks it against Dex's own published
 * keys rather than trusting the web's word — the same reason
 * `services/oauth.ts` re-asks Google and GitHub.
 *
 * What comes out is the same thing the direct path produces: the real provider
 * (google / github) and its own user id. Dex's `federated_claims` carry both,
 * and they are the ids the `google_id` / `github_id` columns already hold —
 * Google's `sub`, GitHub's numeric user id — so an account linked directly
 * keeps signing in through Dex, and the other way round.
 */

/** Dex signs with RS256 and advertises nothing else. Anything else is refused,
 *  `none` and the HMAC family above all. */
const ACCEPTED_ALGORITHMS = ["RS256"];

/**
 * How old a token may be when it arrives. The web posts it within seconds of
 * Dex issuing it; Dex's own ID-token lifetime defaults to a day. Capping the age
 * here means a token copied out of a log or a proxy is useless long before Dex
 * would expire it, whatever the broker's configuration.
 */
const MAX_TOKEN_AGE = "10m";

const DISCOVERY_TIMEOUT_MS = 5_000;

/** Dex's connector ids, which the fleet's broker names after the provider. */
const CONNECTORS: Record<string, OAuthProvider> = { google: "google", github: "github" };

/** What a verified sign-in is: whose provider id, from which provider. */
export interface VerifiedSignIn {
  provider: OAuthProvider;
  profile: OAuthProfile;
}

/**
 * One key set per issuer, for the life of the process. `createRemoteJWKSet`
 * caches the keys and refetches when a token names a key it has not seen, so
 * Dex's key rotation needs nothing from us. A discovery that fails is not
 * cached: the next sign-in tries again rather than every sign-in failing until
 * a restart.
 */
const keySets = new Map<string, Promise<JWTVerifyGetKey>>();

export function resetDexKeysForTests(): void {
  keySets.clear();
}

function keySetFor(issuer: string): Promise<JWTVerifyGetKey> {
  const cached = keySets.get(issuer);
  if (cached) return cached;
  const pending = discover(issuer);
  keySets.set(issuer, pending);
  pending.catch(() => keySets.delete(issuer));
  return pending;
}

/**
 * Read the issuer's discovery document for where its keys are.
 *
 * Two checks before a single key is trusted. The document has to name the
 * issuer we were configured with — OpenID Connect Discovery §4.3 — so a
 * misrouted hostname cannot vouch for itself. And the key set has to live on
 * the issuer's own origin: Dex serves it at `<issuer>/keys`, and a document
 * pointing somewhere else is one that something other than our broker wrote.
 */
async function discover(issuer: string): Promise<JWTVerifyGetKey> {
  const res = await fetch(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`dex discovery answered ${res.status}`);
  const doc = (await res.json()) as { issuer?: unknown; jwks_uri?: unknown };
  if (doc.issuer !== issuer) throw new Error("dex discovery names a different issuer");
  if (typeof doc.jwks_uri !== "string") throw new Error("dex discovery has no jwks_uri");
  const jwksUrl = new URL(doc.jwks_uri);
  if (jwksUrl.origin !== new URL(issuer).origin) {
    throw new Error("dex discovery points its keys off the issuer's origin");
  }
  return createRemoteJWKSet(jwksUrl, { timeoutDuration: DISCOVERY_TIMEOUT_MS });
}

/**
 * Verify a Dex ID token and say whose it is. Throws on anything short of a
 * token Dex signed, for this deployment, recently, naming Google or GitHub.
 *
 *  - signature against the issuer's published keys, RS256 only;
 *  - `iss` exactly `DEX_ISSUER`, `aud` containing `DEX_CLIENT_ID`, and `azp`,
 *    when present, equal to it — a token Dex minted for another tenant's
 *    dashboard opens nothing here;
 *  - `exp` in the future and `iat` within {@link MAX_TOKEN_AGE};
 *  - `federated_claims` naming a connector this api understands and a user id.
 *
 * The address counts only when `email_verified` is true, as on the direct
 * Google path. Without one, a sign-in still resolves an account by its linked
 * provider id; it just cannot link a new one by address, and cannot redeem an
 * invitation.
 */
export async function verifyDexToken(
  token: string,
  source: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedSignIn> {
  const dex = readDexConfig(source);
  if (dex.state !== "on") throw new Error("dex is not configured");
  const { issuer, clientId } = dex.settings;

  const { payload } = await jwtVerify(token, await keySetFor(issuer), {
    issuer,
    audience: clientId,
    algorithms: ACCEPTED_ALGORITHMS,
    maxTokenAge: MAX_TOKEN_AGE,
    requiredClaims: ["exp", "iat"],
  });
  if (payload.azp !== undefined && payload.azp !== clientId) {
    throw new Error("dex token was issued to another client");
  }

  const federated = payload.federated_claims as { connector_id?: unknown; user_id?: unknown } | undefined;
  if (!federated || typeof federated !== "object") {
    throw new Error("dex token has no federated_claims — is the federated:id scope requested?");
  }
  const provider =
    typeof federated.connector_id === "string" ? CONNECTORS[federated.connector_id] : undefined;
  if (!provider) throw new Error("dex token names a connector this api does not know");
  const userId = federated.user_id;
  if (typeof userId !== "string" || userId.length === 0 || userId.length > 255) {
    throw new Error("dex token has no usable federated user id");
  }
  // GitHub ids are numbers, and `github_id` holds the number. Dex's connector
  // can be configured to use the login instead (`useLoginAsID`), which would
  // silently stop matching every account linked before — and a login can be
  // renamed and re-registered by somebody else. Refuse it outright.
  if (provider === "github" && !/^[0-9]+$/.test(userId)) {
    throw new Error("dex GitHub connector must use the numeric GitHub id (useLoginAsID off)");
  }

  const email =
    payload.email_verified === true && typeof payload.email === "string" && payload.email.length > 0
      ? payload.email
      : null;
  const name = typeof payload.name === "string" && payload.name.length > 0 ? payload.name : null;

  return {
    provider,
    profile: {
      providerId: userId,
      email,
      name,
      // Dex passes no picture. GitHub's is addressable by the numeric id;
      // Google's is not, and those accounts fall back to initials.
      avatarUrl: provider === "github" ? `https://avatars.githubusercontent.com/u/${userId}` : null,
    },
  };
}
