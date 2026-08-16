import { redirect } from "next/navigation";
import { ResetForm } from "@/components/auth/reset-form";

export const metadata = {
  title: "New password · Smart Router Dashboard",
  // The token is in this URL; keep it out of the Referer header.
  referrer: "no-referrer" as const,
};
export const dynamic = "force-dynamic";

/**
 * Password reset (AUTH_MODE=enabled only).
 *
 * Unlike the invitation page there is nothing to preview: showing whose account
 * a token belongs to before it is used would turn a guessed token into a way to
 * ask who has an account. The link either works when submitted, or it doesn't.
 */
export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  if (process.env.AUTH_MODE !== "enabled") redirect("/overview");
  const { token } = await params;
  return <ResetForm token={token} />;
}
