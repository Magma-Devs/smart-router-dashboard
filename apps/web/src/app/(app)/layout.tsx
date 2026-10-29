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
  // From this container's env, not the api's: the report button must still
  // render when the api is the thing that broke. The api has its own
  // INCIDENTS_ENABLED and refuses reports while it is off.
  const incidentsEnabled = process.env.INCIDENTS_ENABLED?.trim().toLowerCase() === "true";
  // The Ask your data preview: sample answers only, so off unless asked for.
  const askPreview = process.env.ASK_DATA_PREVIEW?.trim().toLowerCase() === "true";
  return (
    <AuthModeProvider enabled={authEnabled}>
      <FiltersProvider>
        <Shell grafanaDashboardUrl={grafanaDashboardUrl} incidentsEnabled={incidentsEnabled} askPreview={askPreview}>{children}</Shell>
      </FiltersProvider>
    </AuthModeProvider>
  );
}
