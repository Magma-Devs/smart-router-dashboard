"use client";

import { useEffect, type ReactNode } from "react";

/** Where the top bar's theme toggle keeps the choice (`ThemeToggle` in
 *  `gateway/Shell.tsx`). */
export const THEME_STORAGE_KEY = "sr:theme";

/** The saved theme, or null when there is none or storage cannot be read. */
export function savedTheme(read: () => string | null): "light" | "dark" | null {
  try {
    const value = read();
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The page around every screen outside the app shell: sign-in, setup, forgot
 * password, join and reset. It applies the theme the dashboard saved, the way
 * the shell's toggle does on mount, so these pages are not always dark.
 */
export function AuthScreen({ children }: { children: ReactNode }) {
  useEffect(() => {
    const theme = savedTheme(() => window.localStorage.getItem(THEME_STORAGE_KEY));
    if (theme) document.documentElement.setAttribute("data-theme", theme);
  }, []);

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
        padding: 24,
      }}
    >
      {children}
    </main>
  );
}

/** The logo, a title and a line under it. */
export function AuthHeader({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/magma-logo.png"
        width={32}
        height={32}
        alt="Magma"
        style={{ objectFit: "contain" }}
      />
      <div>
        <div style={{ fontWeight: 700, fontSize: 16 }}>{title}</div>
        {subtitle && <div style={{ fontSize: 12, color: "var(--text-3)" }}>{subtitle}</div>}
      </div>
    </div>
  );
}
