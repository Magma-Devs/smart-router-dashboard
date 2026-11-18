"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore, type ComponentType } from "react";
import { signOut } from "next-auth/react";
import { buildChainMetaByIndex, isRole } from "@sr/shared";
import { NAV_SECTIONS, visibleNavSections } from "./nav";
import { useAuthMode } from "./auth-mode";
import { CHAIN_DRAWER_PATH, ChainDrawer, ChainDrawerProvider, useChainDrawer } from "./ChainDrawer";
import { IconMenuCollapse, IconMenuExpand, IconMoon, IconSearch, IconSun, type IconProps } from "./icons";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { DeploymentHealthBadge, useDeploymentPulse } from "./DeploymentHealth";
import { topbarFigures } from "@/lib/upstream-presentation";
import { getAuthVersion, subscribeAuth } from "@/lib/auth-store";
import { useMe } from "@/hooks/use-me";
import { TwoFactorCountdown, TwoFactorGate } from "@/components/auth/two-factor-gate";
import { AskProvider, useAsk } from "@/components/ask/AskProvider";
import { AskTrigger } from "@/components/ask/AskTrigger";
import dynamic from "next/dynamic";
import { ReportIncidentButton } from "@/components/incidents/ReportIncident";
import { openRequestSearch } from "@/lib/request-search";
import { noteSearchFrom, pageOf, startUsage, tabOf, usageSignOut, viewOpened } from "@/lib/usage";
import { UsageConsentBar } from "./UsageConsent";
import { roleBadgeLabel } from "./role-badge";
import { roleChipStyle } from "@/components/team/bits";

const AskDock = dynamic(() => import("@/components/ask/AskViewport").then((module) => module.AskDock), { ssr: false });

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
    <button
      className="gw-btn gw-btn--ghost"
      style={{ padding: 6 }}
      onClick={toggle}
      aria-label="Toggle theme"
    >
      {theme === "dark" ? <IconSun size={14} /> : <IconMoon size={14} />}
    </button>
  );
}

const NARROW_SCREEN = "(max-width: 1599px)";
const watchNarrow = (notify: () => void) => {
  const media = matchMedia(NARROW_SCREEN);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};
function useNarrowScreen(): boolean {
  return useSyncExternalStore(watchNarrow, () => matchMedia(NARROW_SCREEN).matches, () => false);
}

function Sidebar({ grafanaDashboardUrl, grafanaCustomerUsageDashboardUrl }: {
  grafanaDashboardUrl?: string | null;
  grafanaCustomerUsageDashboardUrl?: string | null;
}) {
  const pathname = usePathname();
  const sections = visibleNavSections(useAuthMode(), grafanaDashboardUrl, grafanaCustomerUsageDashboardUrl);
  const { visible: drawerOpen, menuCollapsed, setMenuCollapsed } = useChainDrawer();
  // Beside the Ask panel on a screen under 1600 px the menu folds too, so the
  // page keeps its width; closing the panel brings it back.
  const ask = useAsk();
  const besideAsk = useNarrowScreen() && ask.visible && !ask.full && ask.mode === "panel";
  const compact = menuCollapsed || besideAsk;
  const { setChain, setRouterId, setRouter } = useFilters();
  // Home or Metrics while on Metrics: back to every chain, as the drawer's
  // first row does, with the menu folded again. Navigating would land on the
  // same page with the chain kept.
  const toAllChains = drawerOpen ? (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    setRouterId(null);
    setRouter(null);
    setChain(null);
    setMenuCollapsed(true);
  } : undefined;
  return (
    // Beside the chains drawer the menu folds to its icons, each naming itself
    // on hover, so the page doesn't carry two lists side by side.
    <aside className={`gw-side${compact ? " gw-side--compact" : ""}`}>
      {/* The brand is the way home, as it is on every product: `/` redirects to
          whatever the default surface is (Metrics), so home stays defined in one
          place rather than being restated here. */}
      <Link
        href="/"
        className="gw-side__brand"
        style={{ textDecoration: "none", color: "inherit" }}
        onClick={toAllChains}
        title={compact ? "Smart Router" : undefined}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/magma-logo.png"
          width={26}
          height={26}
          style={{ flexShrink: 0, display: "block", objectFit: "contain" }}
          alt="Magma"
        />
        <div>
          <div className="name">Smart Router</div>
          <div className="sub">by Magma Devs</div>
        </div>
      </Link>
      <nav className="gw-side__nav">
        {drawerOpen && !besideAsk && (
          <button
            type="button"
            className="gw-nav-item gw-side__toggle"
            onClick={() => setMenuCollapsed(!compact)}
            aria-label={compact ? "Expand menu" : "Collapse menu"}
            aria-expanded={!compact}
            title={compact ? "Expand menu" : undefined}
          >
            {compact
              ? <IconMenuExpand size={16} className="ic" strokeWidth={1.75} />
              : <IconMenuCollapse size={16} className="ic" strokeWidth={1.75} />}
            <span>Collapse menu</span>
          </button>
        )}
        {sections.map((section, i) => (
          <div key={i}>
            {section.label && <div className="gw-side__section-label">{section.label}</div>}
            {section.items.map((item) => {
              const Icon: ComponentType<IconProps> = item.icon;
              if (item.external) {
                return (
                  <a
                    key={item.label}
                    href={item.href}
                    className="gw-nav-item"
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${item.label} (opens in a new tab)`}
                    title={compact ? item.label : undefined}
                  >
                    <Icon size={16} className="ic" strokeWidth={1.75} />
                    <span>{item.label}</span>
                  </a>
                );
              }
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`gw-nav-item${active ? " active" : ""}`}
                  onClick={item.href === CHAIN_DRAWER_PATH ? toAllChains : undefined}
                  // The label is hidden while folded, and a hidden label names nothing.
                  aria-label={compact ? item.label : undefined}
                  title={compact ? item.label : undefined}
                >
                  <Icon
                    size={16}
                    className="ic"
                    strokeWidth={1.75}
                    style={{ color: active ? "var(--brand)" : undefined }}
                  />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <SidebarUser />
    </aside>
  );
}

/**
 * Sidebar footer. AUTH_MODE=enabled (session mirrored into the auth
 * store by ApiTokenBridge) → the signed-in user + a working sign-out.
 * AUTH_MODE=disabled (store stays empty) → the self-hosted placeholder.
 */
export function SidebarUser() {
  // Subscribed to the store for the sign-in/sign-out transition, but the role
  // itself comes from `useMe` — the session's copy is frozen at sign-in, so the
  // badge would keep claiming Admin after a demotion. See `useMe`.
  useSyncExternalStore(subscribeAuth, getAuthVersion, () => 0);
  const { me: user } = useMe();

  const logoutIcon = (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );

  return (
    <div className="gw-side__foot">
      <div className="gw-side__user">
        {user?.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={user.avatarUrl}
            alt=""
            width={26}
            height={26}
            style={{ borderRadius: "50%", flexShrink: 0, objectFit: "cover" }}
          />
        ) : (
          <div className="avatar">{(user?.name ?? user?.email ?? "S").charAt(0).toUpperCase()}</div>
        )}
        <div className="meta">
          {/* Signed in → the account's display name (the admin seed is
              "Admin"), email on hover. Signed out (AUTH_MODE=disabled) → the
              self-hosted placeholder. */}
          <div className="email" title={user?.email}>
            {user ? (user.name ?? user.email) : "Self-hosted deployment"}
          </div>
          <div>
            <span
              className="plan-chip"
              style={isRole(user?.role) ? roleChipStyle(user.role) : undefined}
            >
              {roleBadgeLabel(user?.role)}
            </span>
          </div>
        </div>
        {user ? (
          <button
            className="gw-btn gw-btn--ghost"
            style={{ padding: 6 }}
            title="Sign out"
            onClick={() => {
              usageSignOut();
              void signOut({ redirectTo: "/login" });
            }}
          >
            {logoutIcon}
          </button>
        ) : (
          <button
            className="gw-btn gw-btn--ghost"
            style={{ padding: 6 }}
            title="No auth on self-hosted deployments"
            disabled
          >
            {logoutIcon}
          </button>
        )}
      </div>
    </div>
  );
}

/** Find a request from any page: an ID, a transaction hash or the caller's
 *  own request ID opens the Metrics page's look-up on it, in the chain and
 *  router in view (`lib/request-search.ts`). */
function RequestSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const { chain, routerId } = useFilters();
  const [draft, setDraft] = useState("");
  const id = draft.trim();
  return (
    <form className="gw-top__search" role="search" onSubmit={(e) => {
      e.preventDefault();
      if (!id) return;
      noteSearchFrom("top-bar");
      openRequestSearch(id, { chain, router: routerId }, pathname, (url) => router.push(url));
      setDraft("");
    }} title="Find a request by its ID, its transaction hash or your own request ID - any request, answered or not">
      {/* On a narrow header the box folds to its icon; the icon is the input's label, so clicking it opens the box. */}
      <label htmlFor="gw-request-search" style={{ display: "flex", cursor: "text" }}><IconSearch size={14} /></label>
      <input id="gw-request-search" aria-label="Find a request" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Find a request" className="gw-mono" />
    </form>
  );
}

function Topbar({ here, sub, incidentsEnabled }: { here: string; sub: string | null; incidentsEnabled: boolean }) {
  // The router's status describes the selected router across every chain it
  // serves; on a chain's page the provider counts and the list follow the
  // chain (`topbarFigures`).
  const { data, isLoading, error } = useDeploymentPulse();
  const { health, counts } = topbarFigures(data);
  return (
    <header className="gw-top">
      <div className="gw-top__crumbs">
        <span className="gw-top__root" style={{ color: "var(--text-3)" }}>Smart Router</span>
        <svg
          className="gw-top__root"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--text-4)"
          strokeWidth="2"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span className={sub ? undefined : "here"} style={sub ? { color: "var(--text-3)" } : undefined}>{here}</span>
        {sub && (
          <>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-4)" strokeWidth="2">
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <span className="here">{sub}</span>
          </>
        )}
      </div>
      <div className="gw-top__right">
        {/* Drawn only when the router or a provider needs a look; it lists which
            providers, why and since when. No throughput figure and no
            "operational" here: neither tells the reader anything to do. */}
        <DeploymentHealthBadge health={health} counts={counts} attention={data?.attention} loading={!data && isLoading && !error} error={Boolean(error)} />
        {/* Router scope — global, so it sits next to the theme toggle rather
            than in any one page's header. Hides itself when the metrics can't
            be split per router. */}
        {/* The router filter lives in the page header next to the chain one
            (RouterFilterSelect) — it sets the label scope this control used to
            own, plus the config-router filter, so one control does both. */}
        {/* Shows only for the one account that may still defer 2FA. Not
            dismissible: what it counts down to is the dashboard closing. */}
        <TwoFactorCountdown />
        <RequestSearch />
        <ReportIncidentButton enabled={incidentsEnabled} />
        <AskTrigger />
        <ThemeToggle />
      </div>
    </header>
  );
}

export function Shell({
  children,
  grafanaDashboardUrl,
  grafanaCustomerUsageDashboardUrl,
  incidentsEnabled = false,
  askEnabled = false,
}: {
  children: React.ReactNode;
  grafanaDashboardUrl?: string | null;
  grafanaCustomerUsageDashboardUrl?: string | null;
  incidentsEnabled?: boolean;
  askEnabled?: boolean;
}) {
  // Unenrolled sessions never mount the chrome or personal chat state.
  return (
    <TwoFactorGate>
      <ChainDrawerProvider>
        <AskProvider enabled={askEnabled}>
          <ShellChrome
            grafanaDashboardUrl={grafanaDashboardUrl}
            grafanaCustomerUsageDashboardUrl={grafanaCustomerUsageDashboardUrl}
            incidentsEnabled={incidentsEnabled}
          >
            {children}
          </ShellChrome>
        </AskProvider>
      </ChainDrawerProvider>
    </TwoFactorGate>
  );
}
function ShellChrome({
  children,
  grafanaDashboardUrl,
  grafanaCustomerUsageDashboardUrl,
  incidentsEnabled,
}: {
  children: React.ReactNode;
  grafanaDashboardUrl?: string | null;
  grafanaCustomerUsageDashboardUrl?: string | null;
  incidentsEnabled: boolean;
}) {
  const pathname = usePathname();
  const { chain } = useFilters();
  // Usage data (MAG-5373): asked once whether it is on, then each page timed
  // until its data is on screen - sent only once this browser accepted it.
  useEffect(() => {
    startUsage();
    viewOpened(pageOf(pathname), tabOf(pathname, window.location.search));
  }, [pathname]);

  const ask = useAsk();
  const here =
    pathname === "/ask"
      ? "Ask your data"
      : (NAV_SECTIONS.flatMap((section) => section.items).find(
          (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
        )?.label ?? "Overview");
  const sub = pathname === CHAIN_DRAWER_PATH && chain ? buildChainMetaByIndex(chain).name : null;
  return (
    <>
      <div
        className={`gw-app${ask.full ? " gw-app--ask-full" : ""}${ask.visible && !ask.full && ask.mode === "panel" ? " gw-app--ask-panel" : ""}`}
      >
        <Sidebar
          grafanaDashboardUrl={grafanaDashboardUrl}
          grafanaCustomerUsageDashboardUrl={grafanaCustomerUsageDashboardUrl}
        />
        <ChainDrawerSlot />
        <div className="gw-main">
          <Topbar here={here} sub={sub} incidentsEnabled={incidentsEnabled} />
          <div className="fade-in" key={pathname}>
            {children}
          </div>
        </div>
      </div>
      <UsageConsentBar />
      {ask.visible && !ask.full && ask.mode !== "closed" ? <AskDock /> : null}
    </>
  );
}

function ChainDrawerSlot() {
  return useChainDrawer().visible ? <ChainDrawer /> : null;
}
