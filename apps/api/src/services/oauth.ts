import { config } from "../config.js";
import type { OAuthProfile, OAuthProvider } from "./users.js";

/**
 * Server-side OAuth token verification (lava-connect's pattern, condensed).
 * The web's Auth.js signIn callback forwards the provider token here; we
 * verify it against the provider's own API so a forged token can never
 * mint a session. Each function returns the normalized profile or throws.
 */

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

/** Google: the tokeninfo endpoint validates signature + expiry for us;
 *  we additionally pin the audience to our own client id. */
async function verifyGoogle(idToken: string): Promise<OAuthProfile> {
  const info = await fetchJson<{
    sub: string;
    aud: string;
    email?: string;
    email_verified?: string;
    name?: string;
    picture?: string;
  }>(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);

  if (!config.auth.googleClientId || info.aud !== config.auth.googleClientId) {
    throw new Error("google id token audience mismatch");
  }
  return {
    providerId: info.sub,
    email: info.email_verified === "true" ? (info.email ?? null) : null,
    name: info.name ?? null,
    avatarUrl: info.picture ?? null,
  };
}

/** GitHub: exchange the access token for /user, and /user/emails for the
 *  verified primary address (the public profile email can be unset). */
async function verifyGithub(accessToken: string): Promise<OAuthProfile> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "smart-router-dashboard",
  };
  const user = await fetchJson<{
    id: number;
    login: string;
    name?: string | null;
    avatar_url?: string;
  }>("https://api.github.com/user", { headers });

  let email: string | null = null;
  try {
    const emails = await fetchJson<Array<{ email: string; primary: boolean; verified: boolean }>>(
      "https://api.github.com/user/emails",
      { headers },
    );
    email = emails.find((e) => e.primary && e.verified)?.email ?? null;
  } catch {
    /* scope may be missing — fall through with null email */
  }

  return {
    providerId: String(user.id),
    email,
    name: user.name ?? user.login,
    avatarUrl: user.avatar_url ?? null,
  };
}

/** Discord: /users/@me with the OAuth access token. Avatar hash → CDN URL. */
async function verifyDiscord(accessToken: string): Promise<OAuthProfile> {
  const me = await fetchJson<{
    id: string;
    username: string;
    email?: string | null;
    verified?: boolean;
    avatar?: string | null;
  }>("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  return {
    providerId: me.id,
    email: me.verified ? (me.email ?? null) : null,
    name: me.username,
    avatarUrl: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png` : null,
  };
}

export async function verifyOAuthToken(
  provider: OAuthProvider,
  token: string,
): Promise<OAuthProfile> {
  switch (provider) {
    case "google":
      return verifyGoogle(token);
    case "github":
      return verifyGithub(token);
    case "discord":
      return verifyDiscord(token);
  }
}
