import { redirect } from "next/navigation";

/**
 * The audit log does not exist without accounts.
 *
 * The sidebar already hides it in `AUTH_MODE=disabled`, so this catches a typed
 * URL or an old bookmark. Left reachable, the page asks for `/api/audit/events`
 * — a route that is not registered in that mode — and explains itself with an
 * empty state, but explaining is second best: the deployment simply does not
 * have the feature, so the URL should not pretend to.
 *
 * A layout rather than a check inside the page, because the page is a client
 * component and this decision belongs on the server: the same shape `/team`
 * uses.
 */
export default function AuditLayout({ children }: { children: React.ReactNode }) {
  if (process.env.AUTH_MODE !== "enabled") redirect("/overview");
  return children;
}
