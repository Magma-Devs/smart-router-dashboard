import type { ComponentType } from "react";
import {
  IconChart,
  IconGlobe,
  IconHome,
  IconPulse,
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
    label: null,
    items: [{ href: "/overview", label: "Overview", icon: IconHome }],
  },
  {
    label: "Smart Router",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: IconPulse },
      { href: "/upstreams", label: "Upstreams", icon: IconServer },
      { href: "/endpoints", label: "Endpoints", icon: IconGlobe },
      { href: "/metrics", label: "Metrics", icon: IconChart },
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
