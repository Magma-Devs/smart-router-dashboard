import type { ComponentType } from "react";
import {
  IconChart,
  IconGlobe,
  IconHome,
  IconPlay,
  IconPulse,
  IconServer,
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

export const NAV_SECTIONS: NavSection[] = [
  {
    label: null,
    items: [{ href: "/overview", label: "Overview", icon: IconHome }],
  },
  {
    label: "Smart Router",
    items: [
      { href: "/metrics", label: "Metrics", icon: IconChart },
      { href: "/providers", label: "Providers", icon: IconServer },
      { href: "/endpoints", label: "Endpoints", icon: IconGlobe },
      { href: "/live-test", label: "Live test", icon: IconPlay },
    ],
  },
];
