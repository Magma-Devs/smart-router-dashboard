import type { Metadata } from "next";
import localFont from "next/font/local";
import { AuthProvider } from "@/components/auth/auth-provider";
import "@/styles/globals.css";

// The same two families the prototype uses — without them every metric number
// renders in system-ui and nothing is pixel-comparable.
//
// **Vendored, not fetched.** `next/font/google` downloads these at BUILD time
// from URLs baked into Next's own font metadata, and Google rotates the asset
// hashes: gstatic began 404ing the Inter v20 file this version asks for, which
// broke `next build` outright — an image build in CI, and then the dev server,
// with `Module not found: @vercel/turbopack-next/internal/font/google/font`.
// A build that reaches the public internet for an asset somebody else can
// rotate is a build that fails on somebody else's schedule.
//
// These are the latin-subset variable files (one per family, ~47 KB and ~39 KB),
// which cover every weight the design uses. Refresh them from
// fonts.googleapis.com/css2 if a new weight or subset is ever needed.
const inter = localFont({
  src: "./fonts/Inter-latin.woff2",
  weight: "100 900",
  display: "swap",
  variable: "--font-inter",
});
const jbMono = localFont({
  src: "./fonts/JetBrainsMono-latin.woff2",
  weight: "100 800",
  display: "swap",
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
