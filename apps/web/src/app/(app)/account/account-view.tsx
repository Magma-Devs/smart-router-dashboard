"use client";

/* The Account page. Connected accounts, 2FA, Change password and Active
 * sessions act on the signed-in account; About this deployment is the build
 * the api reports at `/version`. The theme toggle lives in the Topbar.
 *
 * With AUTH_MODE=disabled there are no accounts, so only About this deployment
 * renders: the other cards post to routes the api never registers in that mode. */

import { useApi } from "@/hooks/use-api";
import { useMe } from "@/hooks/use-me";
import { ChangePasswordCard } from "@/components/account/ChangePasswordCard";
import { TwoFactorCard } from "@/components/account/TwoFactorCard";
import { SessionsCard } from "@/components/account/SessionsCard";
import type { ProviderFlags } from "@/components/auth/oauth-providers";
import { useAuthMode } from "@/components/gateway/auth-mode";
import { AboutDeployment, type VersionInfo } from "./about-deployment";
import { ConnectedAccounts } from "./connected-accounts";

export function AccountView({ providers }: { providers: ProviderFlags }) {
  const authEnabled = useAuthMode();
  const { me } = useMe();
  const { data: version, error } = useApi<VersionInfo>("/version", 60000);

  return (
    <div className="gw-page" style={{ maxWidth: 720 }}>
      <h1 style={{ marginBottom: 20 }}>Account</h1>

      {authEnabled && (
        <>
          <ConnectedAccounts offered={providers} linked={me?.linkedProviders} email={me?.email} />
          <TwoFactorCard />
          <ChangePasswordCard />
          <SessionsCard />
        </>
      )}

      <AboutDeployment version={version} error={Boolean(error)} />
    </div>
  );
}
