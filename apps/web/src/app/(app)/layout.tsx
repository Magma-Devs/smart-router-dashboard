import { EnrolmentVerdictProvider } from "@/components/auth/two-factor-gate";
import { FiltersProvider } from "@/components/gateway/FiltersProvider";
import { AuthModeProvider } from "@/components/gateway/auth-mode";
import { Shell } from "@/components/gateway/Shell";
import { readEnrolmentVerdict } from "@/lib/enrolment-verdict";
import { normalizeGrafanaDashboardUrl } from "@/lib/grafana-dashboard-url";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Same source as the root layout's SessionProvider decision, one level down,
  // so the chrome and the session plumbing cannot disagree about whether this
  // deployment has accounts.
  const authEnabled = process.env.AUTH_MODE === "enabled";
  const grafanaDashboardUrl = normalizeGrafanaDashboardUrl(process.env.DASHBOARD_GRAFANA_DASHBOARD_URL);
  const grafanaCustomerUsageDashboardUrl = normalizeGrafanaDashboardUrl(process.env.DASHBOARD_GRAFANA_CUSTOMER_USAGE_DASHBOARD_URL);
  // From this container's env, not the api's: the report button must still
  // render when the api is the thing that broke. The api has its own
  // INCIDENTS_ENABLED and refuses reports while it is off.
  const incidentsEnabled = process.env.INCIDENTS_ENABLED?.trim().toLowerCase() === "true";
  // Before anything is drawn: the Shell's two-factor gate needs to know whether
  // to show the enrolment screen instead of the dashboard on its first render,
  // not after the browser has asked. See `lib/enrolment-verdict.ts`.
  const verdict = await readEnrolmentVerdict();
  return (
    <AuthModeProvider enabled={authEnabled}>
      <EnrolmentVerdictProvider verdict={verdict}>
        <FiltersProvider>
          <Shell grafanaDashboardUrl={grafanaDashboardUrl} grafanaCustomerUsageDashboardUrl={grafanaCustomerUsageDashboardUrl} incidentsEnabled={incidentsEnabled}>{children}</Shell>
        </FiltersProvider>
      </EnrolmentVerdictProvider>
    </AuthModeProvider>
  );
}
