import { redirect } from "next/navigation";

/**
 * Team does not exist without accounts.
 *
 * The sidebar already hides it in `AUTH_MODE=disabled`, so this catches a typed
 * URL or an old bookmark. Left reachable, the page asks for `/api/team/members`
 * — a route that is not registered in that mode — and reports "could not load
 * the member list", which reads as a broken deployment rather than one that was
 * never built with a team.
 *
 * A layout rather than a check inside the page, because the page is a client
 * component and this decision belongs on the server: the same shape the login,
 * setup, invite and reset pages already use.
 */
export default function TeamLayout({ children }: { children: React.ReactNode }) {
  if (process.env.AUTH_MODE !== "enabled") redirect("/overview");
  return children;
}
