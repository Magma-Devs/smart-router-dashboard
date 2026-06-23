"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";
import { NAV_SECTIONS } from "./nav";
import { IconMoon, IconSun, MagmaLogo } from "./icons";

function ThemeToggle() {
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
        <MagmaLogo size={28} />
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
              const Icon = item.icon;
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link key={item.href} href={item.href} className={`gw-nav-item${active ? " active" : ""}`}>
                  <Icon size={16} className="ic" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}

function Topbar({ here }: { here: string }) {
  return (
    <header className="gw-top">
      <div className="gw-top__crumbs">
        <span>Smart Router</span>
        <span>/</span>
        <span className="here">{here}</span>
      </div>
      <div className="gw-top__right">
        <span className="pill">
          <span className="dot-ok" /> All systems normal
        </span>
        <ThemeToggle />
      </div>
    </header>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  // Lightweight auth gate: when the API has auth enabled, a token is required.
  useEffect(() => {
    const token = localStorage.getItem("sr:token");
    const authEnabled = localStorage.getItem("sr:authEnabled") === "true";
    if (authEnabled && !token && pathname !== "/login") {
      router.replace("/login");
    }
  }, [pathname, router]);

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
