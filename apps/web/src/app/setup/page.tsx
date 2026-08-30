import { redirect } from "next/navigation";
import { SetupForm } from "@/components/auth/setup-form";
import { fetchBootstrap } from "@/lib/bootstrap";

export const metadata = { title: "Set up · Smart Router Dashboard" };
export const dynamic = "force-dynamic";

/**
 * First-run page (AUTH_MODE=enabled only).
 *
 * Guarded on the way in as well as the way out: an install that already has an
 * account must not show this form at all, or a stranger with the token could
 * mint themselves a second admin. The api refuses that anyway — this just means
 * they never see the field.
 */
export default async function SetupPage() {
  if (process.env.AUTH_MODE !== "enabled") redirect("/overview");

  const state = await fetchBootstrap();
  // Unreachable api ⇒ don't guess. Sending someone to /login is recoverable;
  // showing the setup form on a live deployment is not.
  if (!state || !state.needsSetup) redirect("/login");

  return <SetupForm mode={state.mode} />;
}
