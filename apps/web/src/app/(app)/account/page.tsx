import { oauthProviderFlags } from "@/auth.config";
import { AccountView } from "./account-view";

export const dynamic = "force-dynamic";

/** A server component only to read which sign-in providers this deployment
 *  offers: their credential pairs are the web container's env, and only the
 *  booleans go to the browser. */
export default function AccountPage() {
  return <AccountView providers={oauthProviderFlags} />;
}
