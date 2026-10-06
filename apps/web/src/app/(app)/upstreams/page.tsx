import { UpstreamsView } from "@/components/upstreams/UpstreamsView";
import { UpstreamsView as LegacyUpstreamsView } from "@/legacy/components/upstreams/UpstreamsView";
import { newUiEnabled } from "@/lib/new-ui";

export default function UpstreamsPage() {
  // DASHBOARD_NEW_UI: the 0.28 page, else the 0.27 one (src/legacy).
  return newUiEnabled() ? <UpstreamsView /> : <LegacyUpstreamsView />;
}
