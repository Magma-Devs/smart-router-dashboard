import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { AuthProvider } from "@/components/auth/auth-provider";
import "@/styles/globals.css";

// Self-hosted at build time by next/font — the prototype loads the same two
// families from Google Fonts; without them every metric number renders in
// system-ui and nothing is pixel-comparable.
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
});
const jbMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-jbmono",
});

export const metadata: Metadata = {
  title: "Smart Router · by Magma Devs",
  description: "Smart Router observability dashboard",
  icons: { icon: "/magma-mark.svg" },
};

// The whole tree renders per-request, never at build time. One published
// image must honour the RUNTIME container env (AUTH_MODE, DASHBOARD_*):
// static prerendering would bake the build-time env into the HTML — a
// container started with AUTH_MODE=enabled would serve a disabled-mode
// shell (no SessionProvider) and every data fetch would deadlock waiting
// for a token bridge that never mounts. All real data is client-fetched,
// so the SSR cost of dynamic shells is negligible.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Session plumbing (SessionProvider + token bridge) mounts ONLY when
  // AUTH_MODE=enabled — disabled mode stays session-free with zero
  // /api/auth traffic.
  const authEnabled = process.env.AUTH_MODE === "enabled";
  return (
    <html
      lang="en"
      data-theme="dark"
      data-density="default"
      className={`${inter.variable} ${jbMono.variable}`}
    >
      <body>{authEnabled ? <AuthProvider>{children}</AuthProvider> : children}</body>
    </html>
  );
}
