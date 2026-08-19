import { redirect } from "next/navigation";
import { ResetDead, ResetForm } from "@/components/auth/reset-form";
import { previewReset } from "@/lib/bootstrap";

export const metadata = {
  title: "New password · Smart Router Dashboard",
  // The token is in this URL; keep it out of the Referer header.
  referrer: "no-referrer" as const,
};
export const dynamic = "force-dynamic";

/**
 * Password reset (AUTH_MODE=enabled only) — MAG-2870 §3.
 *
 * The link is previewed before the form renders, so a dead one says so
 * immediately rather than after somebody has typed a password twice, and a live
 * one can name the account it changes.
 *
 * This page used to refuse to preview, arguing that revealing whose account a
 * token belongs to would turn a guessed token into an account-enumeration
 * oracle. That was over-cautious: the token is 32 random bytes, so anyone who
 * can present a valid one can already set the password and read the address
 * from inside. The preview reveals nothing the holder cannot simply take, it is
 * rate-limited, and every failure answers identically.
 */
export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  if (process.env.AUTH_MODE !== "enabled") redirect("/overview");

  const { token } = await params;
  const preview = await previewReset(token);

  // On-prem there is no self-service way to ask for another link — an admin
  // generates them — so the dead state has to point at a person, not a form.
  if (!preview) return <ResetDead managed={process.env.DEPLOYMENT_MODE === "managed"} />;

  return <ResetForm token={token} email={preview.email} />;
}
