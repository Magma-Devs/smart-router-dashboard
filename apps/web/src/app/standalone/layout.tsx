import { FiltersProvider } from "@/components/gateway/FiltersProvider";
import { StandaloneTop } from "@/components/gateway/StandaloneTop";
import { EnrolmentVerdictProvider, TwoFactorGate } from "@/components/auth/two-factor-gate";
import { readEnrolmentVerdict } from "@/lib/enrolment-verdict";

/* The design prototype's standalone branch (app.jsx): the Metrics page with
 * Magma branding but no sidebar/topbar Shell — for sharing/embedding the
 * dashboard on its own. FiltersProvider still wraps it (MetricsView reads the
 * shared time-window from useFilters). */

export default async function StandaloneLayout({ children }: { children: React.ReactNode }) {
  // Behind the same two-factor gate as the Shell: an unenrolled account would
  // otherwise see every panel fail with 403 and no way to enrol from here. The
  // server's read decides the first render, as it does for the Shell.
  const verdict = await readEnrolmentVerdict();
  return (
    <EnrolmentVerdictProvider verdict={verdict}>
    <TwoFactorGate>
    <FiltersProvider>
      <div className="gw-app gw-app--standalone">
        <StandaloneTop />
        <div className="gw-main">
          <div className="fade-in">{children}</div>
        </div>
      </div>
    </FiltersProvider>
    </TwoFactorGate>
    </EnrolmentVerdictProvider>
  );
}
