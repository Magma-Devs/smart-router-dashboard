import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { oauthProviderFlags } from "@/auth.config";
import { LoginForm } from "@/components/auth/login-form";
import { fetchBootstrap } from "@/lib/bootstrap";
import { TWO_FACTOR_HANDOFF_COOKIE, decodeHandoff } from "@/lib/two-factor-handoff";

export const metadata = { title: "Sign in · Smart Router Dashboard" };
export const dynamic = "force-dynamic";

/**
 * Public sign-in page (AUTH_MODE=enabled only — disabled mode bounces
 * straight to the dashboard). Server component: reads the provider
 * credential pairs from the env and passes booleans down, so the client
 * bundle never learns the actual client ids.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string }>;
}) {
  if (process.env.AUTH_MODE !== "enabled") redirect("/overview");

  // A deployment with no accounts has nobody to sign in as. This is the single
  // place that redirect lives — the edge gate already funnels everything here,
  // and the proxy can't reach the database to decide it itself.
  const state = await fetchBootstrap();
  if (state?.needsSetup) redirect("/setup");

  // Back from Google or GitHub with a challenge parked for the code step. Both
  // the query and the cookie, so a reload after "Back" shows the password form
  // rather than a code screen the person walked away from. Only the address and
  // the provider go to the browser — the challenge stays in the httpOnly cookie.
  const { step } = await searchParams;
  const parked =
    step === "code" ? decodeHandoff((await cookies()).get(TWO_FACTOR_HANDOFF_COOKIE)?.value) : null;

  return (
    <LoginForm
      providers={oauthProviderFlags}
      pendingCode={parked ? { email: parked.email, provider: parked.provider } : undefined}
    />
  );
}
