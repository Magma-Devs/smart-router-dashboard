import { redirect } from "next/navigation";
import { oauthProviderFlags } from "@/auth.config";
import { LoginForm } from "@/components/auth/login-form";

export const metadata = { title: "Sign in · Smart Router Dashboard" };

/**
 * Public sign-in page (AUTH_MODE=enabled only — disabled mode bounces
 * straight to the dashboard). Server component: reads the provider
 * credential pairs from the env and passes booleans down, so the client
 * bundle never learns the actual client ids.
 */
export default function LoginPage() {
  if (process.env.AUTH_MODE !== "enabled") redirect("/overview");
  return <LoginForm providers={oauthProviderFlags} />;
}
