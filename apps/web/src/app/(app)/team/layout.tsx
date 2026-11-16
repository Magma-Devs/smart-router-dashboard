import { redirect } from "next/navigation";
import { HOME_PATH } from "@/lib/home-path";
import { DeploymentModeProvider } from "@/components/team/deployment-mode";

/**
 * Team does not exist without accounts.
 *
 * The sidebar already hides it in `AUTH_MODE=disabled`, so this catches a typed
 * URL or an old bookmark. Left reachable, the page asks for `/api/team/members`
 * — a route that is not registered in that mode — and shows an empty member
 * list, which reads as a broken deployment rather than one that was never built
 * with a team.
 *
 * A layout rather than a check inside the page, because the page is a client
 * component and this decision belongs on the server: the same shape the login,
 * setup, invite and reset pages already use. The deployment mode is read here
 * for the same reason: the invite and reset-link dialogs word delivery by it.
 */
export default function TeamLayout({ children }: { children: React.ReactNode }) {
  if (process.env.AUTH_MODE !== "enabled") redirect(HOME_PATH);
  const mode = process.env.DEPLOYMENT_MODE === "managed" ? "managed" : "onprem";
  return <DeploymentModeProvider mode={mode}>{children}</DeploymentModeProvider>;
}
