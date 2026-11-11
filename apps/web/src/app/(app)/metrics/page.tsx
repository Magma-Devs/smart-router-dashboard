import { redirect } from "next/navigation";
import { MetricsView } from "@/components/metrics/MetricsView";
import { MetricsView as LegacyMetricsView } from "@/legacy/components/metrics/MetricsView";
import { newUiEnabled } from "@/lib/new-ui";

export default async function MetricsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tab, provider, upstream, chain } = await searchParams;
  // Providers was a tab here before it had its own page: an old link lands on it.
  if (newUiEnabled() && tab === "providers") {
    redirect(typeof provider === "string" && /^[A-Za-z0-9 ._-]{1,64}$/.test(provider) ? `/providers?provider=${encodeURIComponent(provider)}` : "/providers");
  }
  // A provider's chain row links here to open on one upstream of that chain.
  const openOn = typeof upstream === "string" && typeof chain === "string" ? { endpointId: upstream, spec: chain } : null;
  // DASHBOARD_NEW_UI: the 0.28 page, else the 0.27 one (src/legacy).
  return newUiEnabled() ? <MetricsView openOn={openOn} /> : <LegacyMetricsView />;
}
