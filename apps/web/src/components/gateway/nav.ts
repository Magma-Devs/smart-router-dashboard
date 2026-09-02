import type { ComponentType } from "react";
import {
  IconChart,
  IconServer,
  IconSettings,
  IconTrace,
  IconUsers,
} from "./icons";

export interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
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
      // A point lookup on ONE relay, not an aggregate view, so it sits
      // outside the chain/router/window filter model the others share — which
      // is exactly why it is a route of its own rather than a tab. The path
      // stays /trace: it is short, still accurate, and a URL people paste to
      // each other is the last thing worth churning.
      { href: "/trace", label: "Relay investigator", icon: IconTrace },
    ],
  },
  {
    label: "Account",
    items: [
      { href: "/team", label: "Team", icon: IconUsers },
      { href: "/account", label: "Account", icon: IconSettings },
    ],
  },
];
