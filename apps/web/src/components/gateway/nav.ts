import type { ComponentType } from "react";
import {
  IconChart,
  IconServer,
  IconSettings,
  IconUsers,
} from "./icons";

export interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  /** Drawn only where the deployment has accounts (`AUTH_MODE=enabled`).
   *  Without it the entry leads to a screen whose api routes are not even
   *  registered, which presents as a broken page rather than an absent
   *  feature. Set it on anything the account system owns. */
  requiresAuth?: boolean;
}

export interface NavSection {
  label: string | null;
  items: NavItem[];
}

/** Mirrors the SR Dashboard prototype's sidebar structure. */
export const NAV_SECTIONS: NavSection[] = [
  {
    label: "Smart Router",
    items: [
      // Overview + Dashboard are hidden from nav (Metrics is the default
      // surface); their routes still resolve if linked directly. Endpoints is
      // gone: the Upstreams page's "By router" grouping is that surface, on
      // the same config the other two groupings read.
      { href: "/metrics", label: "Metrics", icon: IconChart },
      { href: "/upstreams", label: "Upstreams", icon: IconServer },
    ],
  },
  {
    label: "Account",
    items: [
      { href: "/team", label: "Team", icon: IconUsers, requiresAuth: true },
      // Account stays without accounts: most of it is the build provenance an
      // operator reads off a self-hosted deployment. The page hides its own
      // credential cards — see `(app)/account/page.tsx`.
      { href: "/account", label: "Account", icon: IconSettings },
    ],
  },
];

/**
 * The sections to draw, with account-only entries removed when the deployment
 * has none, and any section left empty dropped along with its label.
 *
 * Exported and pure so the rule is testable without rendering the shell —
 * "what does the sidebar offer on a deployment with no accounts" is a question
 * worth an assertion rather than a screenshot.
 */
export function visibleNavSections(authEnabled: boolean): NavSection[] {
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => authEnabled || !item.requiresAuth),
  })).filter((section) => section.items.length > 0);
}
