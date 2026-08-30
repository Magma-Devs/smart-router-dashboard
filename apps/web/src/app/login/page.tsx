import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/login-form";
import { fetchBootstrap } from "@/lib/bootstrap";

export const metadata = { title: "Sign in · Smart Router Dashboard" };
export const dynamic = "force-dynamic";

/**
 * Public sign-in page (AUTH_MODE=enabled only — disabled mode bounces
 * straight to the dashboard).
 */
export default async function LoginPage() {
  if (process.env.AUTH_MODE !== "enabled") redirect("/overview");

  // A deployment with no accounts has nobody to sign in as. This is the single
  // place that redirect lives — the edge gate already funnels everything here,
  // and the proxy can't reach the database to decide it itself.
  const state = await fetchBootstrap();
  if (state?.needsSetup) redirect("/setup");

  return <LoginForm />;
}
