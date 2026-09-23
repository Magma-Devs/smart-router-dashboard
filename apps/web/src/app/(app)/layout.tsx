import { FiltersProvider } from "@/components/gateway/FiltersProvider";
import { AuthModeProvider } from "@/components/gateway/auth-mode";
import { Shell } from "@/components/gateway/Shell";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  // Same source as the root layout's SessionProvider decision, one level down,
  // so the chrome and the session plumbing cannot disagree about whether this
  // deployment has accounts.
  const authEnabled = process.env.AUTH_MODE === "enabled";
  return (
    <AuthModeProvider enabled={authEnabled}>
      <FiltersProvider>
        <Shell>{children}</Shell>
      </FiltersProvider>
    </AuthModeProvider>
  );
}
