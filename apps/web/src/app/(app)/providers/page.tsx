import { notFound } from "next/navigation";
import { ProvidersView } from "@/components/providers/ProvidersView";
import { newUiEnabled } from "@/lib/new-ui";

export default function ProvidersPage() {
  // DASHBOARD_NEW_UI only: the 0.27 screens have no Providers page.
  if (!newUiEnabled()) notFound();
  return <ProvidersView />;
}
