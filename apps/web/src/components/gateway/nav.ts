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
      { href: "/team", label: "Team", icon: IconUsers },
      { href: "/account", label: "Account", icon: IconSettings },
    ],
  },
];
