import { FiltersProvider } from "@/components/gateway/FiltersProvider";
import { Shell } from "@/components/gateway/Shell";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <FiltersProvider>
      <Shell>{children}</Shell>
    </FiltersProvider>
  );
}
