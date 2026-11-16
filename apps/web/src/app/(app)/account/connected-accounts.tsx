"use client";

import { enabledProviders, type ProviderFlags } from "@/components/auth/oauth-providers";

/**
 * Each sign-in provider this deployment offers, and whether this account is
 * linked to it. Nothing here links or unlinks: a sign-in with a provider whose
 * verified address matches the account links it (`upsertOAuthUser`). The card
 * is absent where the deployment offers no provider.
 */
export function ConnectedAccounts({
  offered,
  linked,
  email,
}: {
  offered: ProviderFlags;
  /** Undefined until the account has been read; the rows then show no status. */
  linked: ProviderFlags | undefined;
  email: string | undefined;
}) {
  const providers = enabledProviders(offered);
  if (providers.length === 0) return null;
  const unlinked = linked === undefined ? [] : providers.filter((p) => !linked[p.id]);

  return (
    <section className="gw-card" style={{ marginBottom: 14 }}>
      <h2 style={{ fontSize: 13, fontWeight: 600, margin: "0 0 12px" }}>Connected accounts</h2>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
        {providers.map((p) => (
          <li key={p.id} className="gw-row" style={{ gap: 10, fontSize: 13 }}>
            {p.icon}
            <span style={{ flex: 1 }}>{p.label}</span>
            {linked &&
              (linked[p.id] ? (
                <span className="gw-tag gw-tag--ok">Linked</span>
              ) : (
                <span className="gw-tag">Not linked</span>
              ))}
          </li>
        ))}
      </ul>
      {unlinked.length > 0 && (
        <p style={{ margin: "12px 0 0", fontSize: 12, color: "var(--text-3)", lineHeight: 1.6 }}>
          To link one, sign in with it once. Its verified address has to be{" "}
          {email ?? "this account's address"}
          {unlinked.some((p) => p.id === "github") ? " (on GitHub, your primary address)." : "."}
        </p>
      )}
    </section>
  );
}
