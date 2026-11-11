import { notFound } from "next/navigation";
import { ProvidersView } from "@/components/providers/ProvidersView";
import { newUiEnabled } from "@/lib/new-ui";

export default async function ProvidersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // DASHBOARD_NEW_UI only: the 0.27 screens have no Providers page.
  if (!newUiEnabled()) notFound();
  // The provider a link opens on, read here: on an in-app navigation the
  // browser's address still holds the page being left when the view first renders.
  const { provider } = await searchParams;
  const initialProvider = typeof provider === "string" && /^[A-Za-z0-9 ._-]{1,64}$/.test(provider) ? provider : null;
  return <ProvidersView initialProvider={initialProvider} />;
}
