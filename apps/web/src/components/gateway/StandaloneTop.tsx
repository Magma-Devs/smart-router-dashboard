"use client";

import { DeploymentHealth } from "./DeploymentHealth";
import { ThemeToggle } from "./Shell";

/* Ported from the design prototype (app.jsx StandaloneTop): a stripped
   shell for sharing/embedding the dashboard on its own — keeps Magma
   branding, drops breadcrumbs, plan pill, sidebar nav, and account chrome.
   Theme handling reuses the Shell's ThemeToggle. */

export function StandaloneTop() {
  return (
    <header className="gw-standalone-top">
      <div className="brand">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/magma-logo.png" width={28} height={28} style={{ flexShrink: 0, display: "block", objectFit: "contain" }} alt="Magma" />
        <div style={{ lineHeight: 1.2 }}>
          <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: "-0.01em" }}>Smart Router</div>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-3)" }}>by Magma Devs</div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <DeploymentHealth />
        <ThemeToggle />
      </div>
    </header>
  );
}
