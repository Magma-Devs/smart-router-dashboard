import { redirect } from "next/navigation";
import { ForgotForm } from "@/components/auth/forgot-form";

export const metadata = { title: "Reset password · Smart Router Dashboard" };
export const dynamic = "force-dynamic";

/**
 * Asking for a reset link (AUTH_MODE=enabled only).
 *
 * Reachable in both deployment shapes on purpose, even though only managed can
 * send anything. On-prem the api answers 404 — there is nowhere to send it —
 * and the form says so and points at an administrator. Hiding the page there
 * would leave somebody who followed a bookmark staring at a redirect with no
 * explanation, which is the failure this ticket has hit repeatedly.
 */
export default function ForgotPasswordPage() {
  if (process.env.AUTH_MODE !== "enabled") redirect("/overview");
  return <ForgotForm />;
}
