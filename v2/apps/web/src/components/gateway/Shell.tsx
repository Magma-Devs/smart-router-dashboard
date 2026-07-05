"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useEffect, useState, type ComponentType } from "react";
import type { OverviewData } from "@sr/shared";
import { NAV_SECTIONS } from "./nav";
import { IconMoon, IconSun, type IconProps } from "./icons";
import { useApi } from "@/hooks/use-api";
import { fmtNum } from "@/lib/format";

export function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    const saved = (localStorage.getItem("sr:theme") as "dark" | "light") ?? "dark";
    setTheme(saved);
    document.documentElement.setAttribute("data-theme", saved);
  }, []);
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("sr:theme", next);
    document.documentElement.setAttribute("data-theme", next);
  };
  return (
    <button className="gw-btn gw-btn--ghost" style={{ padding: 6 }} onClick={toggle} aria-label="Toggle theme">
      {theme === "dark" ? <IconSun size={14} /> : <IconMoon size={14} />}
    </button>
  );
}

function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="gw-side">
      <div className="gw-side__brand">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/magma-logo.png" width={26} height={26} style={{ flexShrink: 0, display: "block", objectFit: "contain" }} alt="Magma" />
        <div>
          <div className="name">Smart Router</div>
          <div className="sub">by Magma Devs</div>
        </div>
      </div>
      <nav className="gw-side__nav">
        {NAV_SECTIONS.map((section, i) => (
          <div key={i}>
            {section.label && <div className="gw-side__section-label">{section.label}</div>}
            {section.items.map((item) => {
              const Icon: ComponentType<IconProps> = item.icon;
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link key={item.href} href={item.href} className={`gw-nav-item${active ? " active" : ""}`}>
                  <Icon size={16} className="ic" strokeWidth={1.75} style={{ color: active ? "var(--brand)" : undefined }} />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="gw-side__foot">
        <div className="gw-side__user">
          <div className="avatar">S</div>
          <div className="meta">
            <div className="email">Self-hosted deployment</div>
            <div>
              <span className="plan-chip">local</span>
            </div>
          </div>
          <button className="gw-btn gw-btn--ghost" style={{ padding: 6 }} title="No auth on self-hosted deployments" disabled>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>
        </div>
      </div>
    </aside>
  );
}

function Topbar({ here }: { here: string }) {
  // Live throughput + health for the top-bar stats (real data; CU/mo is a
  // Lava-consumer concept the router doesn't emit, so it's omitted here).
  const { data } = useApi<OverviewData>("/api/metrics/overview?window=1h", 30000);
  const rps = data?.throughputRps.value;
  const ok = data?.health === "operational";
  return (
    <header className="gw-top">
      <div className="gw-top__crumbs">
        <span style={{ color: "var(--text-3)" }}>Smart Router</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-4)" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
        <span className="here">{here}</span>
      </div>
      <div className="gw-top__right">
        <span className="pill gw-mono" title="Live throughput">
          {fmtNum(rps)} RPS
        </span>
        <span className="pill">
          <span className={ok ? "dot-ok" : "dot-warn"} />
          {ok ? "All systems normal" : data ? "Degraded" : "…"}
        </span>
        <ThemeToggle />
      </div>
    </header>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  const here =
    NAV_SECTIONS.flatMap((s) => s.items).find(
      (i) => pathname === i.href || pathname.startsWith(`${i.href}/`),
    )?.label ?? "Overview";

  return (
    <div className="gw-app">
      <Sidebar />
      <div className="gw-main">
        <Topbar here={here} />
        <div className="fade-in" key={pathname}>
          {children}
        </div>
      </div>
    </div>
  );
}
