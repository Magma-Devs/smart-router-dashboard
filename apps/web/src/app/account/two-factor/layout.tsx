import { redirect } from "next/navigation";

/**
 * AUTH_MODE=disabled has no accounts and registers none of the enrolment
 * routes, so this screen would only render "could not start setup". Same
 * server-side guard as /login, /setup and the other account pages.
 */
export default function TwoFactorLayout({ children }: { children: React.ReactNode }) {
  if (process.env.AUTH_MODE !== "enabled") redirect("/overview");
  return <>{children}</>;
}
