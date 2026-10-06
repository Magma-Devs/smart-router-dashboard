"use client";

import type { ReactNode } from "react";
import { explorerBlockUrl, explorerHome, primaryExplorer } from "@sr/shared";

/**
 * Links from a number the dashboard renders to the public chain that can
 * confirm it. Two components, one rule:
 *
 *   a VALUE  → the block page   (<ExplorerBlockLink>)
 *   an IDENTITY → the explorer home  (<ExplorerHomeLink>)
 *
 * The split is forced by what the catalog can honestly offer: 145 chains have
 * a proven block-page shape, 68 have an explorer but no shape, and 32 have no
 * explorer at all. Linking only the chain would throw the block link away;
 * linking only the height would leave the middle 68 with nothing.
 *
 * Both render their children unlinked when there is nothing to link, so call
 * sites never branch on coverage — a table cell stays one expression.
 *
 * `<ExplorerBlockLink>` deliberately does NOT fall back to the explorer home.
 * Someone who clicks a specific height and lands on a front page has been
 * misled; a plain number is the honest answer. That is the contract
 * `explorerBlockUrl()` already encodes (docs/CHAINS.md).
 */

/** Rows in both tables are clickable. A link inside one must not also toggle
 *  the row, so every click stops there. */
const stop = (e: React.MouseEvent) => e.stopPropagation();

/** Registry-supplied names are lowercase ("etherscan", "mintscan") because
 *  that is how the registries spell them. Capitalise for display only — the
 *  catalog keeps the name it was given. */
const label = (name: string | undefined) =>
  name ? name.charAt(0).toUpperCase() + name.slice(1) : "the chain\u2019s explorer";

const linkStyle: React.CSSProperties = {
  color: "inherit",
  textDecoration: "none",
  borderBottom: "1px solid transparent",
};

/** Shared hover affordance: the underline appears on hover only, so a dense
 *  table does not turn into a wall of links. */
const hoverProps = {
  onMouseEnter: (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.currentTarget.style.borderBottomColor = "var(--text-3)";
  },
  onMouseLeave: (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.currentTarget.style.borderBottomColor = "transparent";
  },
};

/**
 * A block height, linked to that block on the chain's explorer when a proven
 * shape exists. `children` is what to render — the caller keeps its own
 * formatting, colour and alignment.
 */
export function ExplorerBlockLink({
  spec,
  block,
  children,
}: {
  spec: string;
  block: number | string | null | undefined;
  children: ReactNode;
}) {
  const href = block == null ? null : explorerBlockUrl(spec, block);
  if (!href) return <>{children}</>;
  const name = label(primaryExplorer(spec)?.name);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={stop}
      title={`Block ${block} on ${name}`}
      style={linkStyle}
      {...hoverProps}
    >
      {children}
    </a>
  );
}

/** A small outbound arrow. Persistent rather than hover-only: a chain icon
 *  gives no hint that it is clickable, and an affordance nobody sees is the
 *  same as no link. It is muted until the link is hovered. */
function OutboundArrow() {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ color: "var(--text-4)", flexShrink: 0, marginLeft: 1, marginTop: -6 }}
    >
      <line x1="7" y1="17" x2="17" y2="7" />
      <polyline points="7 7 17 7 17 17" />
    </svg>
  );
}

/**
 * A chain's identity — its badge, its name — linked to the explorer's home
 * page. This is what the chains with no proven block shape can still offer,
 * and it is the right destination for an identity in any case.
 *
 * `arrow` marks it as outbound. On by default: in a table the identity is an
 * icon, which reads as decoration rather than as a link.
 */
export function ExplorerHomeLink({
  spec,
  children,
  arrow = true,
}: {
  spec: string;
  children: ReactNode;
  arrow?: boolean;
}) {
  const href = explorerHome(spec);
  if (!href) return <>{children}</>;
  const name = label(primaryExplorer(spec)?.name);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={stop}
      title={`Open ${name}`}
      // An explicit gap rather than `inherit`: the two tables space their chain
      // cells differently, and the arrow should sit the same distance from the
      // mark in both.
      style={{ ...linkStyle, display: "inline-flex", alignItems: "center", gap: 3 }}
      {...hoverProps}
    >
      {children}
      {arrow && <OutboundArrow />}
    </a>
  );
}
