import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { InviteDead, InviteForm, InviteSignedIn } from "@/components/auth/invite-form";
import { previewInvitation } from "@/lib/bootstrap";

export const metadata = {
  title: "Join · Smart Router Dashboard",
  // The token is in this URL. Without this it would ride along in the Referer
  // header of anything the page links to or loads.
  referrer: "no-referrer" as const,
};
export const dynamic = "force-dynamic";

/**
 * Invitation redemption (AUTH_MODE=enabled only).
 *
 * The token is in the URL because the link has to survive an email or a
 * copy-paste, so it lands in browser history — mitigated by a short TTL, single
 * use, and `Referrer-Policy: no-referrer` from the root layout. It is never put
 * in an *api* URL: the preview and accept calls carry it in a POST body.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  if (process.env.AUTH_MODE !== "enabled") redirect("/overview");

  const { token } = await params;
  const invite = await previewInvitation(token);
  if (!invite) return <InviteDead />;

  // Signed in already? Say so rather than redirecting. Resolved here rather
  // than in the edge gate because the useful sentence names the invited
  // address, which the gate cannot see without reading the database.
  const session = await auth();
  const signedInAs = session?.user?.email;
  if (signedInAs) {
    return <InviteSignedIn token={token} invitedEmail={invite.email} signedInAs={signedInAs} />;
  }

  return <InviteForm token={token} email={invite.email} role={invite.role} />;
}
