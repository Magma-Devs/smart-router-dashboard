import type { Metadata } from "next";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: "Smart Router · by Magma Devs",
  description: "Smart Router observability dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" data-density="default">
      <body>{children}</body>
    </html>
  );
}
