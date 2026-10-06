import { MetricsView } from "@/components/metrics/MetricsView";
import { MetricsView as LegacyMetricsView } from "@/legacy/components/metrics/MetricsView";
import { newUiEnabled } from "@/lib/new-ui";

export default function MetricsPage() {
  // DASHBOARD_NEW_UI: the 0.28 page, else the 0.27 one (src/legacy).
  return newUiEnabled() ? <MetricsView /> : <LegacyMetricsView />;
}
