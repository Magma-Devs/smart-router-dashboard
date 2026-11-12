import { redirect } from "next/navigation";
import { HOME_PATH } from "@/lib/home-path";

/**
 * AUTH_MODE=disabled has no accounts and registers none of the enrolment
 * routes, so this screen would only render "could not start setup". Same
 * server-side guard as /login, /setup and the other account pages.
 */
export default function TwoFactorLayout({ children }: { children: React.ReactNode }) {
  if (process.env.AUTH_MODE !== "enabled") redirect(HOME_PATH);
  return <>{children}</>;
}
