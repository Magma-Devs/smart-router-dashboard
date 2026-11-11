import { FiltersProvider } from "@/components/gateway/FiltersProvider";
import { AuthModeProvider } from "@/components/gateway/auth-mode";
import { Shell } from "@/components/gateway/Shell";
import { normalizeGrafanaDashboardUrl } from "@/lib/grafana-dashboard-url";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  // Same source as the root layout's SessionProvider decision, one level down,
  // so the chrome and the session plumbing cannot disagree about whether this
  // deployment has accounts.
  const authEnabled = process.env.AUTH_MODE === "enabled";
  const grafanaDashboardUrl = normalizeGrafanaDashboardUrl(process.env.DASHBOARD_GRAFANA_DASHBOARD_URL);
  return (
    <AuthModeProvider enabled={authEnabled}>
      <FiltersProvider>
        <Shell grafanaDashboardUrl={grafanaDashboardUrl}>{children}</Shell>
      </FiltersProvider>
    </AuthModeProvider>
  );
}
