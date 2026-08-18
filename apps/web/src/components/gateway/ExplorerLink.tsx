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

/**
 * A chain's identity — its badge, its name — linked to the explorer's home
 * page. This is what the 68 chains with no proven block shape can still
 * offer, and it is the right destination for an identity in any case.
 */
export function ExplorerHomeLink({
  spec,
  children,
}: {
  spec: string;
  children: ReactNode;
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
      style={{ ...linkStyle, display: "inline-flex", alignItems: "center", gap: "inherit" }}
      {...hoverProps}
    >
      {children}
    </a>
  );
}
