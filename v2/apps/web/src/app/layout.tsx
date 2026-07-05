import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
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
  icons: { icon: "/lava-mark.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="dark"
      data-density="default"
      className={`${inter.variable} ${jbMono.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
