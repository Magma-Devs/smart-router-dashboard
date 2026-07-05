import { FiltersProvider } from "@/components/gateway/FiltersProvider";
import { StandaloneTop } from "@/components/gateway/StandaloneTop";

/* The design prototype's standalone branch (app.jsx): the Metrics page with
 * Magma branding but no sidebar/topbar Shell — for sharing/embedding the
 * dashboard on its own. FiltersProvider still wraps it (MetricsView reads the
 * shared time-window from useFilters). */

export default function StandaloneLayout({ children }: { children: React.ReactNode }) {
  return (
    <FiltersProvider>
      <div className="gw-app gw-app--standalone">
        <StandaloneTop />
        <div className="gw-main">
          <div className="fade-in">{children}</div>
        </div>
      </div>
    </FiltersProvider>
  );
}
