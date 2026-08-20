"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { buildChainMetaByIndex, type HealthState, type UpstreamRelayResponse } from "@sr/shared";
import { apiPost } from "@/lib/api-client";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { CopyButton } from "@/components/gateway/CopyButton";
import { HealthTag } from "@/components/gateway/HealthTag";
import { initialTargetFor, pinRefusalFor, pinRefusalHintFor, type UpstreamTier } from "./pin-support";
import {
  buildRequest,
  paramsKindFor,
  type ResolvedRequest,
} from "./build-request";
import {
  directAvailableFor,
  resolveDirectPath,
  relayPayloadFor,
  type DirectTarget,
} from "./direct-request";
import {
  groupByInternalPath,
  headCommands,
  httpVariantOf,
  ifaceCanFire,
  storageKey,
  wsVariantOf,
  TIER_ORDER,
  listMethods,
  type AddonCommand,
  type CatalogInterface,
  type InterfaceConfig,
  type Tier,
} from "./chain-methods";
import { CodeBlock } from "./code-block";
import {
  COMMON_METHODS,
  commandKey,
  commandSignature,
  friendlyName,
} from "./method-label";
import { JsonDisplay } from "./json-display";
import {
  grpcDiscoveryCli,
  snippetsFor,
  type SnippetBlock,
  type Snippets,
} from "./snippets";

type CodeTab = "CLI" | "Python" | "Go" | "JavaScript";
type Status = "idle" | "loading" | "ok" | "error";
type WsPhase = "connecting" | "open" | null;
/** Which of the endpoint's two transports the console is driving. */
type Transport = "http" | "ws";
/** Live reachability of the WebSocket transport, measured by opening one. */
type WsProbe = "checking" | "online" | "offline";

/** Give up on a handshake that hasn't opened by then — a router that accepts
 *  the TCP connection but never upgrades would otherwise hang the tag. */
const WS_PROBE_TIMEOUT_MS = 6_000;

/** Human-facing label for the iface — shown as a pill in the drawer header
 *  so the user can see at a glance which transport they're firing against. */
export const IFACE_LABEL: Record<CatalogInterface, string> = {
  jsonrpc: "JSON-RPC",
  "jsonrpc-ws": "JSON-RPC over WS",
  rest: "REST",
  tendermintrpc: "Tendermint RPC",
  "tendermintrpc-ws": "Tendermint RPC over WS",
  grpc: "gRPC",
  "grpc-web": "gRPC-Web",
};

interface TryMeDrawerProps {
  /** Lava spec label (`ETH1`, `SOLANA`, …) — display metadata is resolved
   *  via `buildChainMetaByIndex`. */
  spec: string;
  /** Network name from the router topology (`mainnet`, `testnet`, …). */
  network: string;
  /** Transport the console drives. `wsUrl` adds its WebSocket twin. */
  iface: CatalogInterface;
  cfg: InterfaceConfig;
  endpointUrl: string;
  /** WebSocket address for the SAME endpoint (the router serves the upgrade
   *  on the base interface's address, path-scoped). Set ⇒ the drawer offers a
   *  HTTP / WebSocket toggle; null ⇒ HTTP only. */
  wsUrl?: string | null;
  /** Which transport to open on. A ws-flagged upstream row opens on "ws". */
  initialTransport?: Transport;
  /** Live health from /api/metrics/chains, when the page has it. The status
   *  tag is omitted entirely when undefined — never a hardcoded status. */
  health?: HealthState;
  /** When set, pin the relay to THIS provider via the router's
   *  `lava-select-provider` header (HTTP only — browsers can't set custom
   *  headers on a WebSocket handshake). Used by the per-upstream Try-now. */
  selectUpstream?: string;
  /** Identity of the upstream endpoint(s) this row stands for. Set ⇒ the
   *  drawer offers "Direct to upstream": the api dials the upstream itself,
   *  leaving the router (and its cache, retries and hedging) out of the
   *  measurement. Null ⇒ router-only, as on the Endpoints page. */
  directTarget?: DirectTarget | null;
  /** Which of the router's two pools this endpoint sits in. A backup cannot be
   *  pinned at all (see `pin-support.ts`), so the drawer says why and opens on
   *  the direct leg instead. */
  upstreamTier?: UpstreamTier;
  onClose: () => void;
}

/** Where a fired request went — the router (pinned or not) or the upstream. */
type Via = "router" | "upstream";

/** One fired request, whichever path it took. The drawer renders these the
 *  same way; only the metadata each path can honestly report differs. */
interface Outcome {
  errored: boolean;
  httpStatus: number | null;
  latencyMs: number;
  body: unknown;
  /** Router-only telemetry, read off CORS-exposed response headers. A direct
   *  call has none of it — there is no router in the path to report. */
  servedBy: string | null;
  retries: number | null;
  cvStatus: string | null;
  cvAgreeing: string | null;
  cvDisagreeing: string | null;
  truncated: boolean;
}

/** The router-telemetry half of an Outcome, all absent. A direct call fills
 *  in exactly this: with no router in the path there is nothing to report. */
const NO_ROUTER_META = {
  servedBy: null,
  retries: null,
  cvStatus: null,
  cvAgreeing: null,
  cvDisagreeing: null,
  truncated: false,
} as const;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Key-order-independent equality, so two JSON bodies that differ only in
 *  serialization order aren't reported as a disagreement. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const SECTION_LABEL: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  color: "var(--text-3)",
  marginBottom: 8,
};

const BLOCK_LABEL: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "var(--text-2)",
  marginBottom: 6,
};

const FIELD_INPUT: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--line-2)",
  background: "var(--bg)",
  color: "var(--text)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  outline: "none",
};

const INFO_BANNER: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "flex-start",
  padding: "10px 12px",
  borderRadius: 8,
  background: "var(--hover)",
  border: "1px solid var(--line)",
  fontSize: 11,
  color: "var(--text-2)",
  lineHeight: 1.5,
};

/* ── Inline stroke icons (lucide-react is not shipped in v2) ────────────── */

interface InlineIconProps {
  size?: number;
  style?: CSSProperties;
}

function iconSvgProps({ size = 14, style }: InlineIconProps) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    style,
  };
}

function IconX(props: InlineIconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function IconZap(props: InlineIconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

function IconInfo(props: InlineIconProps) {
  return (
    <svg {...iconSvgProps(props)}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
}

/** Composite key encoding tier + index so duplicate method names across tiers
 *  remain selectable. */
function keyOf(tier: Tier, index: number): string {
  return `${tier}:${index}`;
}

function parseKey(
  k: string,
): { tier: Tier; index: number } | null {
  const [tier, indexStr] = k.split(":");
  if (!tier || indexStr === undefined) return null;
  if (!TIER_ORDER.includes(tier as Tier)) return null;
  const index = Number.parseInt(indexStr, 10);
  if (Number.isNaN(index)) return null;
  return { tier: tier as Tier, index };
}

function defaultParamsFor(command: AddonCommand, iface: CatalogInterface): string {
  if (paramsKindFor(iface) === "json") {
    try {
      return JSON.stringify(JSON.parse(command.params), null, 2);
    } catch {
      return command.params;
    }
  }
  return command.params;
}

function Spinner() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 13 13"
      style={{ animation: "tryme-spin 0.7s linear infinite", display: "block" }}
    >
      <style>{`@keyframes tryme-spin{to{transform:rotate(360deg)}}`}</style>
      <circle
        cx="6.5"
        cy="6.5"
        r="5"
        fill="none"
        stroke="rgba(255,255,255,0.25)"
        strokeWidth="1.8"
      />
      <path
        d="M6.5 1.5 A5 5 0 0 1 11.5 6.5"
        fill="none"
        stroke="white"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Tabs({
  tabs,
  active,
  setActive,
}: {
  tabs: readonly CodeTab[];
  active: CodeTab;
  setActive: (t: CodeTab) => void;
}) {
  return (
    <div
      className="gw-row"
      style={{ borderBottom: "1px solid var(--line)", gap: 0, marginBottom: 10 }}
    >
      {tabs.map((t) => {
        const on = active === t;
        return (
          <button
            key={t}
            onClick={() => setActive(t)}
            style={{
              padding: "7px 14px",
              fontSize: 12,
              fontWeight: on ? 600 : 400,
              border: "none",
              background: "transparent",
              cursor: "pointer",
              color: on ? "var(--text)" : "var(--text-3)",
              borderBottom: `2px solid ${on ? "var(--brand)" : "transparent"}`,
              fontFamily: "var(--font-mono)",
              marginBottom: -1,
            }}
          >
            {t}
          </button>
        );
      })}
    </div>
  );
}

const CODE_TABS: readonly CodeTab[] = ["CLI", "Python", "Go", "JavaScript"];

function blocksForTab(snippets: Snippets, tab: CodeTab): SnippetBlock[] {
  switch (tab) {
    case "CLI":
      return snippets.cli;
    case "Python":
      return snippets.python;
    case "Go":
      return snippets.go;
    case "JavaScript":
      return snippets.javascript;
  }
}

/** WebSocket Send. Opens, sends one JSON frame, resolves on the first message,
 *  then closes. Times out after 15s so a hung router can't lock the UI.
 *  Calls `onOpen` once the underlying socket transitions to OPEN so the UI
 *  can surface a "Socket open" indicator between connect and first message. */
async function sendWebSocket(
  url: string,
  body: unknown,
  options: { onOpen?: () => void; timeoutMs?: number } = {},
): Promise<{ json: unknown; errored: boolean; latencyMs: number }> {
  const { onOpen, timeoutMs = 15_000 } = options;
  const t0 = performance.now();
  return new Promise((resolve) => {
    let resolved = false;
    let socket: WebSocket;
    const finish = (json: unknown, errored: boolean) => {
      if (resolved) return;
      resolved = true;
      const latencyMs = Math.round(performance.now() - t0);
      try {
        socket.close();
      } catch {
        /* noop */
      }
      resolve({ json, errored, latencyMs });
    };
    try {
      socket = new WebSocket(url);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      finish({ error: { message: `Failed to open WebSocket: ${msg}` } }, true);
      return;
    }
    const timer = setTimeout(() => {
      finish({ error: { message: `Timed out after ${timeoutMs}ms` } }, true);
    }, timeoutMs);
    socket.onopen = () => {
      onOpen?.();
      try {
        socket.send(JSON.stringify(body));
      } catch (e) {
        clearTimeout(timer);
        const msg = e instanceof Error ? e.message : String(e);
        finish({ error: { message: `WebSocket send failed: ${msg}` } }, true);
      }
    };
    socket.onmessage = (event) => {
      clearTimeout(timer);
      const data: unknown = event.data;
      let json: unknown;
      try {
        json = typeof data === "string" ? JSON.parse(data) : data;
      } catch {
        json = { _raw: data };
      }
      const errored =
        typeof json === "object" && json !== null && "error" in json;
      finish(json, errored);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      // Browsers intentionally hide WS error details (see WHATWG spec).
      finish({ error: { message: "WebSocket connection failed" } }, true);
    };
    socket.onclose = (event) => {
      if (resolved) return;
      clearTimeout(timer);
      if (!event.wasClean) {
        finish(
          { error: { message: `WebSocket closed unexpectedly (code ${event.code})` } },
          true,
        );
      }
    };
  });
}

export function TryMeDrawer({
  spec,
  network,
  iface: openedIface,
  cfg,
  endpointUrl: httpUrl,
  wsUrl = null,
  initialTransport = "http",
  health,
  selectUpstream,
  directTarget = null,
  upstreamTier = "primary",
  onClose,
}: TryMeDrawerProps) {
  const chain = buildChainMetaByIndex(spec);
  const baseIface = httpVariantOf(openedIface);
  const wsIface = wsVariantOf(openedIface);
  /** Both transports are the same endpoint, so the toggle needs a ws address
   *  and an interface that HAS a ws form (REST and gRPC don't). */
  const canToggleTransport = wsUrl !== null && wsIface !== null;
  const [transport, setTransport] = useState<Transport>(
    canToggleTransport && initialTransport === "ws" ? "ws" : "http",
  );
  /** Why the router can't be pinned to this upstream, when it can't — a
   *  backup lives outside the pool `lava-select-provider` is matched against.
   *  The long form goes in the banner; the hint is the hover on every control
   *  this turns off. */
  const pinRefusal = pinRefusalFor(upstreamTier);
  const pinHint = pinRefusalHintFor(upstreamTier);
  /** Router (the default — what the endpoint actually serves) vs. straight at
   *  the upstream. Kept as state rather than derived so switching transports
   *  doesn't silently change WHERE a send goes. Opens on the direct leg for an
   *  upstream the router cannot be pinned to: that is the only path which
   *  reaches it, and the effect below bounces the choice back if the transport
   *  the drawer opens on has nothing to dial. */
  const [target, setTarget] = useState<Via>(() =>
    initialTargetFor({
      tier: upstreamTier,
      directAvailable:
        directTarget !== null &&
        directAvailableFor(directTarget, canToggleTransport && initialTransport === "ws"),
    }),
  );
  const onWs = transport === "ws" && wsIface !== null && wsUrl !== null;
  /* The transport actually being driven. The two share a method catalog
     (`storageKey` collapses `-ws`), so switching changes only the dial
     address, the request envelope, and whether subscriptions are offered.
     Everything below reads these — never the props. */
  const iface = onWs ? wsIface : baseIface;
  const endpointUrl = onWs ? wsUrl : httpUrl;
  const flat = useMemo(() => {
    const all = listMethods(cfg);
    // Subscription methods ride a WebSocket — over plain HTTP they can only
    // fail ("notifications not supported"), so offer them on -ws variants only.
    if (iface.endsWith("-ws")) return all;
    return all.filter((m) => !/(un)?subscribe$/i.test(m.command.method));
  }, [cfg, iface]);
  /** Tiers in render order that actually have methods on this iface. */
  const availableTiers = useMemo(
    () => TIER_ORDER.filter((t) => (cfg[t]?.length ?? 0) > 0),
    [cfg],
  );
  const first = flat[0];

  const canFire = ifaceCanFire(iface);
  /** Whether the api can dial this row's upstream on the transport currently
   *  selected — an upstream with no `wss://` entry has nothing to dial when
   *  the drawer is on WS. */
  const directAvailable = directTarget !== null && canFire && directAvailableFor(directTarget, onWs);
  const onDirect = target === "upstream" && directAvailable;
  /** Masked `scheme://host` of the upstream a direct call would hit. Display
   *  only — the path (where API keys live) never leaves the api. */
  const directHost = (onWs ? directTarget?.wsHost : directTarget?.httpHost) ?? null;

  const [selectedTier, setSelectedTier] = useState<Tier>(
    first?.tier ?? availableTiers[0] ?? "regular",
  );
  const [selKey, setSelKey] = useState<string>(
    first ? keyOf(first.tier, first.index) : "",
  );
  const [paramsText, setParamsText] = useState<string>(
    first ? defaultParamsFor(first.command, iface) : "",
  );
  const [status, setStatus] = useState<Status>("idle");
  const [showAllCmds, setShowAllCmds] = useState(false);
  const [response, setResponse] = useState<unknown>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [httpStatus, setHttpStatus] = useState<number | null>(null);
  /** Raw `Lava-Provider-Address` response header — which upstream(s) served
   *  the relay, or "Cached" when the router answered from cache. Null when the
   *  header wasn't readable (e.g. not CORS-exposed by the router). */
  const [servedBy, setServedBy] = useState<string | null>(null);
  // Per-request relay telemetry from the router's CORS-exposed headers:
  // Lava-Retries (how many times the relay was retried before succeeding) and
  // Lava-Cross-Validation-Status/…-Agreeing-Providers.
  const [retries, setRetries] = useState<number | null>(null);
  const [cvStatus, setCvStatus] = useState<string | null>(null);
  const [cvAgreeing, setCvAgreeing] = useState<string | null>(null);
  const [cvDisagreeing, setCvDisagreeing] = useState<string | null>(null);
  /** Which path the CURRENT result took, so the meta row can't claim router
   *  telemetry for a direct call (or the reverse). Null before the first
   *  send. */
  const [resultVia, setResultVia] = useState<Via | null>(null);
  const [truncated, setTruncated] = useState(false);
  /** Send with `lava-force-cache-refresh`, so the router bypasses its relay
   *  cache and asks an upstream even when a cached answer exists. Router HTTP
   *  only — the directive rides a header, which a browser WebSocket handshake
   *  can't carry, and the direct leg has no router cache to skip. */
  const [skipCache, setSkipCache] = useState(false);
  /** Side-by-side outcome of "Compare both", or null when not run. */
  const [comparison, setComparison] = useState<{ router: Outcome; upstream: Outcome } | null>(null);
  const [comparing, setComparing] = useState(false);
  const [wsPhase, setWsPhase] = useState<WsPhase>(null);
  const [wsProbe, setWsProbe] = useState<WsProbe | null>(null);
  /** Bumped to re-run the probe on demand (clicking the tag). */
  const [probeNonce, setProbeNonce] = useState(0);
  const [codeTab, setCodeTab] = useState<CodeTab>("CLI");
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    setVisible(false);
    setTimeout(onClose, 240);
  }, [onClose]);

  useEffect(() => {
    setMounted(true);
    requestAnimationFrame(() => setVisible(true));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  const selected = useMemo(() => {
    const parsed = parseKey(selKey);
    if (!parsed) return null;
    return flat.find((m) => m.tier === parsed.tier && m.index === parsed.index) ?? null;
  }, [flat, selKey]);

  /** A method the selected upstream's url cannot serve — a /v3 call aimed at
   *  an endpoint pinned to /v2. No path we compose reaches it, so the drawer
   *  refuses before Send rather than relaying the upstream's 404 as a verdict
   *  on the request. Router mode is unaffected: there the router picks the
   *  upstream from the method's own collection. */
  const directPathRefusal = useMemo(() => {
    if (!onDirect || !selected) return null;
    const resolvedPath = resolveDirectPath({
      methodPath: selected.command.internalPath,
      endpointPath: onWs ? directTarget?.wsInternalPath : directTarget?.httpInternalPath,
    });
    return resolvedPath.ok ? null : resolvedPath.error;
  }, [onDirect, selected, onWs, directTarget]);

  /** Drop everything the LAST send produced — a result belongs to the exact
   *  (command, transport) that produced it. */
  const resetResult = useCallback(() => {
    setStatus("idle");
    setResponse(null);
    setLatencyMs(null);
    setHttpStatus(null);
    setServedBy(null);
    setRetries(null);
    setCvStatus(null);
    setCvAgreeing(null);
    setCvDisagreeing(null);
    setTruncated(false);
    setResultVia(null);
    setComparison(null);
    setWsPhase(null);
  }, []);

  const handleSelect = (next: string) => {
    setSelKey(next);
    const parsed = parseKey(next);
    if (!parsed) return;
    const cmd = flat.find((m) => m.tier === parsed.tier && m.index === parsed.index);
    if (cmd) setParamsText(defaultParamsFor(cmd.command, iface));
    resetResult();
  };

  /* Live reachability of the WebSocket transport — measured by opening one
     from THIS browser, not read off a metrics series. A chain's Prometheus
     health says nothing about whether the ws upgrade is served (the router
     answers HTTP on the same port either way), and it is the browser's own
     handshake that has to succeed for Send to work here. */
  useEffect(() => {
    if (!onWs) {
      setWsProbe(null);
      return;
    }
    let settled = false;
    setWsProbe("checking");
    let socket: WebSocket;
    try {
      socket = new WebSocket(endpointUrl);
    } catch {
      setWsProbe("offline");
      return;
    }
    const finish = (state: WsProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setWsProbe(state);
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    };
    const timer = setTimeout(() => finish("offline"), WS_PROBE_TIMEOUT_MS);
    // OPEN is the whole test: the router rejects a bare handshake with 405,
    // so reaching open means this exact URL serves WebSocket.
    socket.onopen = () => finish("online");
    socket.onerror = () => finish("offline");
    socket.onclose = () => finish("offline");
    return () => {
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    };
  }, [onWs, endpointUrl, probeNonce]);

  const switchTransport = (next: Transport) => {
    if (next === transport) return;
    setTransport(next);
    setShowAllCmds(false);
    resetResult();
  };

  /* Switching transport re-filters the method list (subscriptions are offered
     over a socket only), so a selection can go stale. Snap to the first method
     the new transport does offer. */
  useEffect(() => {
    if (flat.length === 0) return;
    if (flat.some((m) => keyOf(m.tier, m.index) === selKey)) return;
    const next = flat[0]!;
    setSelectedTier(next.tier);
    setSelKey(keyOf(next.tier, next.index));
    setParamsText(defaultParamsFor(next.command, iface));
  }, [flat, selKey, iface]);

  const handleTierChange = (tier: Tier) => {
    setSelectedTier(tier);
    setShowAllCmds(false);
    // Snap selection to the first method in the newly-selected tier so
    // the command dropdown lands on a real value rather than ""/empty.
    if ((cfg[tier]?.length ?? 0) > 0) {
      handleSelect(keyOf(tier, 0));
    }
  };

  /** Commands in the selected tier, with their catalog index kept so
   *  keyOf(tier, i) stays valid however the list is filtered. Read off
   *  `flat`, not `cfg`, so the dropdown can never offer a command the
   *  transport filter has removed — a subscription listed over plain HTTP
   *  selected to nothing, because `selected` looks it up in `flat`. */
  const tierCmds = useMemo(
    () =>
      flat
        .filter((m) => m.tier === selectedTier)
        .map((m) => ({ cmd: m.command, i: m.index })),
    [flat, selectedTier],
  );
  /** What the dropdown opens on: commands that run AS-IS on this chain.
   *  Curated names lead (COMMON_METHODS key order is the display order), the
   *  rest of the runnable set follows in catalog order. Anything needing
   *  params is behind "Show all", labelled. */
  const curatedCmds = useMemo(() => {
    const order = Object.keys(COMMON_METHODS[storageKey(iface)] ?? {});
    const rank = new Map(order.map((key, i) => [key, i]));
    const head = headCommands(
      tierCmds.map(({ cmd }) => cmd),
      (cmd) => rank.has(commandKey(iface, cmd)),
    ).sort((a, b) => {
      const ra = rank.get(commandKey(iface, a)) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(commandKey(iface, b)) ?? Number.MAX_SAFE_INTEGER;
      return ra - rb;
    });
    return head
      .map((cmd) => tierCmds.find((row) => row.cmd === cmd))
      .filter((row): row is (typeof tierCmds)[number] => !!row);
  }, [tierCmds, iface]);
  const curatedCount = curatedCmds.length;
  /** What the dropdown lists: the curated subset until the user expands, with
   *  the current selection kept in view when it isn't part of it. */
  const shownCmds = useMemo(() => {
    if (showAllCmds || curatedCount === 0) return tierCmds;
    if (curatedCmds.some(({ i }) => keyOf(selectedTier, i) === selKey)) return curatedCmds;
    return [
      ...tierCmds.filter(({ i }) => keyOf(selectedTier, i) === selKey),
      ...curatedCmds,
    ];
  }, [showAllCmds, curatedCount, curatedCmds, tierCmds, selectedTier, selKey]);
  /** The dropdown's rows grouped by internal path, so a spec that splits an
   *  interface across versions reads as versions (`/v2` … `/v3`) instead of
   *  one alphabetical run where `/estimateFee` appears twice with nothing to
   *  tell the two apart. */
  const shownGroups = useMemo(() => groupByInternalPath(shownCmds), [shownCmds]);

  const built = useMemo(() => {
    if (!selected) return null;
    return buildRequest(iface, selected.command, paramsText, endpointUrl);
  }, [selected, paramsText, endpointUrl, iface]);

  const resolved: ResolvedRequest | null = built && built.ok ? built.request : null;
  const buildError: string | null = built && !built.ok ? built.error : null;

  // Toggling to a transport this upstream doesn't serve directly (no ws url
  // in the values file) drops back to the router rather than leaving a Send
  // button that can only fail.
  useEffect(() => {
    if (target === "upstream" && !directAvailable) setTarget("router");
  }, [target, directAvailable]);

  const snippets = useMemo<Snippets | null>(() => {
    if (!resolved) return null;
    // Direct mode prints no snippets. The browser never holds the upstream's
    // real url — the api masks it to scheme+host, because that is where API
    // keys live — so the only command this could offer names a placeholder
    // the reader has to resolve out of the mounted values file first, and
    // once they have opened that file they no longer need the snippet. The
    // Code section belongs to the router path, which IS dialable.
    if (onDirect) return null;
    return snippetsFor(resolved, selectUpstream);
  }, [resolved, selectUpstream, onDirect]);

  const applyOutcome = useCallback((o: Outcome, via: Via) => {
    setLatencyMs(o.latencyMs);
    setHttpStatus(o.httpStatus);
    setServedBy(o.servedBy);
    setRetries(o.retries);
    setCvStatus(o.cvStatus);
    setCvAgreeing(o.cvAgreeing);
    setCvDisagreeing(o.cvDisagreeing);
    setTruncated(o.truncated);
    setStatus(o.errored ? "error" : "ok");
    setResponse(o.body);
    setResultVia(via);
  }, []);

  /** Through the router — the path a real client takes. Pinned to one
   *  upstream when the caller asked for it, but still the router's relay:
   *  its cache can answer, and its retries/hedging can change who served. */
  const fireViaRouter = useCallback(async (): Promise<Outcome> => {
    const t0 = performance.now();
    if (resolved?.transport === "ws") {
      setWsPhase("connecting");
      const { json, errored, latencyMs } = await sendWebSocket(resolved.url, resolved.body, {
        onOpen: () => setWsPhase("open"),
      });
      setWsPhase(null);
      return { ...NO_ROUTER_META, errored, httpStatus: null, latencyMs, body: json };
    }
    if (resolved?.transport !== "http") {
      // gRPC needs a client the browser doesn't have; the UI hides Send for it.
      throw new Error("This transport can't be fired from the browser.");
    }
    // Pin the relay to a specific upstream when the caller asked for it
    // (per-upstream Try-now) — the router routes it to that upstream only.
    const headers: Record<string, string> = {};
    if (selectUpstream) headers["lava-select-provider"] = selectUpstream;
    // The router's cache-skip directive: presence of the header makes the
    // relay bypass the cache read (a hit would answer as "Cached" otherwise).
    if (skipCache) headers["lava-force-cache-refresh"] = "true";
    const init: RequestInit = { headers };
    if (resolved.httpMethod === "POST") {
      init.method = "POST";
      // A REST POST carries its arguments in the PATH (body null) — sending
      // "null" as a body is what a nodeos / java-tron endpoint rejects. Only
      // the JSON-RPC envelope has a body to send.
      if (resolved.body !== null) {
        headers["Content-Type"] = resolved.contentType ?? "application/json";
        init.body = JSON.stringify(resolved.body);
      }
    }
    const res = await fetch(resolved.url, init);
    const dt = Math.round(performance.now() - t0);
    let json: unknown;
    try {
      json = await res.clone().json();
    } catch {
      const text = await res.text();
      json = { _raw: text };
    }
    const retriesHdr = res.headers.get("Lava-Retries");
    return {
      errored: !res.ok || (typeof json === "object" && json !== null && "error" in json),
      httpStatus: res.status,
      latencyMs: dt,
      body: json,
      // Which upstream served the relay — the router's Lava-Provider-Address
      // header (a real endpoint name, or "Cached" on a cache hit). Readable
      // only when the router CORS-exposes it; null otherwise.
      servedBy: res.headers.get("Lava-Provider-Address"),
      retries: retriesHdr !== null && retriesHdr !== "" ? Number(retriesHdr) || 0 : null,
      cvStatus: res.headers.get("Lava-Cross-Validation-Status"),
      cvAgreeing: res.headers.get("Lava-Cross-Validation-Agreeing-Providers"),
      cvDisagreeing: res.headers.get("Lava-Cross-Validation-Disagreeing-Providers"),
      truncated: false,
    };
  }, [resolved, selectUpstream, skipCache]);

  /** Straight at the upstream, via the api — no router in the path at all.
   *  The browser can't do this itself: it holds only a masked `scheme://host`,
   *  and upstreams don't answer cross-origin browser calls anyway. */
  const fireDirect = useCallback(async (): Promise<Outcome> => {
    if (!resolved || directTarget === null) throw new Error("No upstream endpoint to dial.");
    const built = relayPayloadFor({
      resolved,
      paramsText,
      iface,
      target: directTarget,
      methodInternalPath: selected?.command.internalPath ?? null,
    });
    if (!built.ok) throw new Error(built.error);
    if (built.payload.transport === "ws") setWsPhase("connecting");
    try {
      const res = await apiPost<UpstreamRelayResponse>("/api/upstreams/relay", built.payload);
      return {
        ...NO_ROUTER_META,
        errored:
          (res.httpStatus !== null && res.httpStatus >= 400) ||
          (typeof res.body === "object" && res.body !== null && "error" in res.body),
        httpStatus: res.httpStatus,
        latencyMs: res.latencyMs,
        body: res.body,
        truncated: res.truncated,
      };
    } finally {
      setWsPhase(null);
    }
  }, [resolved, paramsText, iface, directTarget, selected]);

  const send = useCallback(async () => {
    if (!resolved) return;
    if (resolved.transport === "grpc" || resolved.transport === "grpc-web") {
      // Snippets-only — the UI hides Send for these. Defensive no-op.
      setStatus("idle");
      return;
    }
    const via: Via = onDirect ? "upstream" : "router";
    resetResult();
    setStatus("loading");
    const t0 = performance.now();
    try {
      applyOutcome(via === "upstream" ? await fireDirect() : await fireViaRouter(), via);
    } catch (e) {
      setWsPhase(null);
      setLatencyMs(Math.round(performance.now() - t0));
      setStatus("error");
      setResultVia(via);
      setResponse({ error: { message: errorText(e) } });
    }
  }, [resolved, onDirect, fireDirect, fireViaRouter, applyOutcome, resetResult]);

  /** Fire BOTH paths and put the two answers side by side — the question the
   *  direct mode exists to answer ("is the router adding latency / changing
   *  the answer?") needs both halves in one view. Sequential, router first:
   *  two concurrent calls would contend on the same upstream and make both
   *  latency numbers meaningless.
   *
   *  Requires a pinnable upstream. Against a backup the router leg answers
   *  from whichever PRIMARY the optimizer picked, so the two rows would be
   *  two different upstreams — a comparison of nothing. */
  const compareBoth = useCallback(async () => {
    if (!resolved || !directAvailable || pinRefusal || directPathRefusal) return;
    resetResult();
    setComparing(true);
    setStatus("loading");
    const t0 = performance.now();
    try {
      const routerOut = await fireViaRouter();
      const upstreamOut = await fireDirect();
      setComparison({ router: routerOut, upstream: upstreamOut });
      // The router's answer is what a real client would have received, so it
      // is the one the Response section renders.
      applyOutcome(routerOut, "router");
    } catch (e) {
      setWsPhase(null);
      setLatencyMs(Math.round(performance.now() - t0));
      setStatus("error");
      setResponse({ error: { message: errorText(e) } });
    } finally {
      setComparing(false);
    }
  }, [resolved, directAvailable, pinRefusal, directPathRefusal, fireViaRouter, fireDirect, applyOutcome, resetResult]);

  if (!mounted) return null;

  const paramsLabel = paramsKindFor(iface) === "json" ? "Params (JSON)" : "Path";

  const drawer = (
    <>
      <div
        // The drawer is portaled to <body>, but React events still bubble
        // through the COMPONENT tree — without stopPropagation these clicks reach
        // the endpoint row's onClick and open the detail sheet. Stop them here.
        onClick={(e) => { e.stopPropagation(); close(); }}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 40,
          background: "rgba(0,0,0,0.4)",
          backdropFilter: "blur(2px)",
          opacity: visible ? 1 : 0,
          transition: "opacity 0.24s ease",
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Try ${chain.name} ${spec}`}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          zIndex: 41,
          width: "min(860px, 100vw)",
          background: "var(--surface)",
          borderLeft: "1px solid var(--line-2)",
          boxShadow: "-20px 0 60px rgba(0,0,0,0.5)",
          display: "flex",
          flexDirection: "column",
          transform: visible ? "translateX(0)" : "translateX(100%)",
          transition: "transform 0.26s cubic-bezier(0.4,0,0.2,1)",
          overflowY: "auto",
        }}
      >
        <div
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid var(--line)",
            display: "flex",
            alignItems: "center",
            gap: 12,
            position: "sticky",
            top: 0,
            background: "var(--surface)",
            zIndex: 2,
          }}
        >
          <ChainBadge spec={spec} size={26} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              className="gw-row"
              style={{ gap: 8, alignItems: "center", minWidth: 0 }}
            >
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  letterSpacing: "-0.01em",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {chain.name}
              </span>
              <span
                className="gw-mono"
                style={{
                  flexShrink: 0,
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "2px 7px",
                  borderRadius: 4,
                  background: "rgba(255,57,0,0.12)",
                  color: "var(--brand)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                {IFACE_LABEL[iface]}
              </span>
            </div>
            <div
              className="gw-mono"
              style={{
                fontSize: 10,
                color: "var(--text-3)",
                marginTop: 2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {spec}
              {network && network.toLowerCase() !== spec.toLowerCase()
                ? ` · ${network}`
                : ""}
            </div>
          </div>
          {/* On WebSocket the status is the browser's own handshake against
              this exact URL — the chain's Prometheus health can't tell you
              whether the upgrade is served. Click to re-check. */}
          {onWs ? (
            <button
              type="button"
              onClick={() => setProbeNonce((n) => n + 1)}
              className={
                wsProbe === "online"
                  ? "gw-tag gw-tag--ok"
                  : wsProbe === "offline"
                    ? "gw-tag gw-tag--err"
                    : "gw-tag"
              }
              title={
                wsProbe === "online"
                  ? `WebSocket handshake to ${endpointUrl} succeeded from this browser — click to re-check`
                  : wsProbe === "offline"
                    ? `WebSocket handshake to ${endpointUrl} failed from this browser — click to re-check`
                    : `Opening a WebSocket to ${endpointUrl}…`
              }
              style={{ fontSize: 10, cursor: "pointer", flexShrink: 0 }}
            >
              ws · {wsProbe ?? "checking"}
            </button>
          ) : (
            health !== undefined && (
              <HealthTag health={health} />
            )
          )}
          <button
            ref={closeButtonRef}
            type="button"
            className="gw-btn gw-btn--ghost"
            onClick={close}
            aria-label="Close"
            style={{ padding: 6 }}
          >
            <IconX size={14} />
          </button>
        </div>

        <div
          style={{
            padding: "10px 18px",
            borderBottom: "1px solid var(--line)",
            background: "var(--bg)",
          }}
        >
          <div className="gw-row" style={{ gap: 8 }}>
            {/* One endpoint, two transports: the router serves the WebSocket
                upgrade on the same address, path-scoped. Switching swaps the
                dial address shown here and the envelope Send puts on the
                wire. */}
            {canToggleTransport && (
              <div className="gw-row" style={{ gap: 0, flexShrink: 0, border: "1px solid var(--line-2)", borderRadius: 6, overflow: "hidden" }}>
                {(["http", "ws"] as const).map((t) => {
                  const active = t === transport;
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => switchTransport(t)}
                      title={t === "http" ? "Send over HTTP" : `Send over WebSocket (${wsUrl})`}
                      style={{
                        padding: "3px 9px",
                        fontSize: 10,
                        fontWeight: active ? 700 : 500,
                        border: "none",
                        background: active ? "rgba(255,57,0,0.12)" : "transparent",
                        color: active ? "var(--brand)" : "var(--text-3)",
                        cursor: "pointer",
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                      }}
                    >
                      {t === "http" ? "HTTP" : "WS"}
                    </button>
                  );
                })}
              </div>
            )}
            {/* The address this Send will actually hit. In direct mode that
                is the upstream — shown masked, with a dimmed `/…` standing in
                for the path the api holds and never ships to the browser. */}
            <span
              className="gw-mono"
              style={{
                fontSize: 11,
                color: "var(--text-3)",
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={
                onDirect
                  ? "The upstream's full url (path, query, any API key) lives in the mounted values file and is never sent to the browser."
                  : undefined
              }
            >
              {onDirect ? (
                <>
                  {directHost ?? "upstream"}
                  <span style={{ opacity: 0.5 }}>/…</span>
                </>
              ) : (
                endpointUrl
              )}
            </span>
            {onDirect ? (
              <span
                className="gw-tag"
                style={{ fontSize: 10, color: "var(--text-3)", whiteSpace: "nowrap" }}
                title="There is no url to copy — the dashboard never receives the upstream's full address."
              >
                url masked
              </span>
            ) : (
              <CopyButton text={endpointUrl} />
            )}
          </div>
        </div>

        <div
          style={{
            padding: "18px",
            display: "flex",
            flexDirection: "column",
            gap: 18,
            flex: 1,
          }}
        >
          {(selectUpstream || directTarget) && (
            <div style={{
              display: "flex", flexDirection: "column", gap: 8, padding: "9px 12px", borderRadius: 8,
              background: "rgba(255,57,0,0.06)", border: "1px solid rgba(255,57,0,0.22)",
              fontSize: 12, color: "var(--text-2)", lineHeight: 1.5,
            }}>
              <div className="gw-row" style={{ gap: 9, alignItems: "center" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
                <strong style={{ color: "var(--text)", fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 12 }}>
                  {selectUpstream ?? directTarget?.node}
                </strong>
                {upstreamTier === "backup" && (
                  <span className="gw-tag" style={{ fontSize: 10 }}>backup</span>
                )}
                {directTarget && (
                  <div style={{ display: "flex", gap: 0, marginLeft: "auto", borderRadius: 6, overflow: "hidden", border: "1px solid var(--line-2)" }}>
                    {(["router", "upstream"] as const).map((t) => {
                      // A leg the router will refuse never reads as the
                      // selected one, even when the drawer has nowhere else to
                      // sit (a ws transport this node has no url for).
                      const active =
                        (t === "upstream") === onDirect && !(t === "router" && pinRefusal !== null);
                      // The router leg is not offered at all when the router
                      // would refuse the pin: every send it could make comes
                      // back -32000, so an enabled control here is an invitation
                      // to run a request for its error message.
                      const disabled =
                        t === "upstream" ? !directAvailable : pinRefusal !== null;
                      const hint =
                        t === "router"
                          ? (pinHint ?? "Send through the router, pinned to this upstream.")
                          : disabled
                            ? "This upstream has no url for the selected transport in the values file."
                            : "Send straight to this upstream — the api dials it, no router in the path.";
                      return (
                        // The tooltip hangs on the wrapper, not the button: a
                        // disabled control takes no pointer events, so a title
                        // on it would never be shown — and the whole point of
                        // turning this one off is that the reader can ask why.
                        <span key={t} title={hint} style={{ display: "inline-flex" }}>
                        <button
                          type="button"
                          disabled={disabled}
                          aria-label={`${t === "router" ? "Via router" : "Direct to upstream"} — ${hint}`}
                          onClick={() => setTarget(t)}
                          style={{
                            padding: "3px 10px",
                            fontSize: 11,
                            fontWeight: active ? 600 : 500,
                            border: "none",
                            cursor: disabled ? "not-allowed" : "pointer",
                            opacity: disabled ? 0.4 : 1,
                            // Struck through rather than merely dimmed: a
                            // greyed control reads as "not now", and this one
                            // is "not for this upstream, ever".
                            textDecoration:
                              disabled && t === "router" ? "line-through" : "none",
                            color: active ? "var(--brand)" : "var(--text-3)",
                            background: active ? "rgba(255,57,0,0.12)" : "var(--bg)",
                          }}
                        >
                          {t === "router" ? "Via router" : "Direct to upstream"}
                        </button>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
              <span>
                {onDirect ? (
                  <>
                    The api dials this upstream itself — <strong style={{ color: "var(--text)" }}>the router is not in the path</strong>, so no cache, no retries, no hedging, and none of the <span className="gw-mono">Lava-*</span> headers. Latency is measured at the api, so it isn&apos;t comparable to the router number above it.
                    {pinRefusal && (
                      <>
                        {" "}Opened here because the router can&apos;t be pinned to a backup — this is the one path that reaches it.
                      </>
                    )}
                    {directPathRefusal && (
                      <>
                        {" "}
                        <strong style={{ color: "var(--warn)" }}>{directPathRefusal}</strong>
                      </>
                    )}
                  </>
                ) : pinRefusal ? (
                  <>
                    <strong style={{ color: "var(--text)" }}>The router can&apos;t be told to use this upstream.</strong>{" "}
                    It matches <span className="gw-mono">lava-select-provider</span> against its primary pool only. A backup is reached
                    solely when every primary is exhausted, and the router picks among the backups itself — so a pinned request comes back{" "}
                    <span className="gw-mono">-32000 Selected provider not available</span> however healthy this upstream is. Send it{" "}
                    {directTarget ? "direct to the upstream instead" : "through the router unpinned, or read it on the Upstreams roster"}.
                  </>
                ) : selectUpstream ? (
                  <>
                    Pinned to <strong style={{ color: "var(--text)", fontFamily: "var(--font-mono)", fontWeight: 600 }}>{selectUpstream}</strong> — sent with the <span className="gw-mono">lava-select-provider</span> header so the router routes this request to that upstream (a cache hit may still answer as &quot;Cached&quot;).
                  </>
                ) : (
                  <>Sent through the router, which picks the upstream.</>
                )}
              </span>
            </div>
          )}
          {availableTiers.length > 1 && (
            <div>
              <div style={SECTION_LABEL}>Request Type</div>
              <div className="gw-row" style={{ gap: 6, flexWrap: "wrap" }}>
                {availableTiers.map((tier) => {
                  const active = tier === selectedTier;
                  const label = tier[0]?.toUpperCase() + tier.slice(1);
                  return (
                    <button
                      key={tier}
                      type="button"
                      onClick={() => handleTierChange(tier)}
                      style={{
                        padding: "5px 12px",
                        fontSize: 11,
                        fontWeight: active ? 600 : 500,
                        borderRadius: 6,
                        border: `1px solid ${active ? "var(--brand)" : "var(--line-2)"}`,
                        background: active ? "rgba(255,57,0,0.1)" : "var(--bg)",
                        color: active ? "var(--brand)" : "var(--text-2)",
                        cursor: "pointer",
                        textTransform: "capitalize",
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {flat.length === 0 ? (
            /* A gRPC surface with no method catalog (see GRPC_NO_CATALOG).
               There is no method list to offer, so offer the call that asks
               the endpoint what it serves. */
            <div>
              <div style={SECTION_LABEL}>Discover services</div>
              <div style={{ ...INFO_BANNER, marginBottom: 10 }}>
                <IconInfo size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>
                  {chain.name}&apos;s spec declares no gRPC method list, so this
                  console has none to show. Server reflection asks the endpoint
                  itself what it serves.
                </span>
              </div>
              <CodeBlock code={grpcDiscoveryCli(endpointUrl)} language="bash" />
            </div>
          ) : (
          <>
          <div>
            <div style={SECTION_LABEL}>Command</div>
            <select
              value={selKey}
              onChange={(e) => handleSelect(e.target.value)}
              style={{ ...FIELD_INPUT, fontSize: 12 }}
            >
              {shownGroups.map(([path, rows]) => {
                const options = rows.map(({ cmd, i }) => {
                  // Curated name → the catalog's own label → one derived from
                  // the method id or REST path, so the "Show all" long tail
                  // reads like the curated head instead of dropping to bare
                  // ids.
                  const friendly = friendlyName(iface, cmd);
                  const id = commandKey(iface, cmd);
                  // The head runs as-is; the long tail behind it doesn't, so
                  // say which entries want something typed in first.
                  const suffix = cmd.needsInput ? " — needs params" : "";
                  return (
                    <option key={i} value={keyOf(selectedTier, i)}>
                      {friendly ? `${friendly} · ${id}${suffix}` : `${id}${suffix}`}
                    </option>
                  );
                });
                // Ungrouped when the interface serves everything from one
                // place — which is every chain but the handful that split an
                // interface across internal paths.
                return path === null ? (
                  options
                ) : (
                  <optgroup key={path} label={path}>
                    {options}
                  </optgroup>
                );
              })}
            </select>
            {curatedCount > 0 && tierCmds.length > curatedCount && (
              <button
                onClick={() => setShowAllCmds((s) => !s)}
                style={{ marginTop: 6, border: "none", background: "none", color: "var(--brand)", cursor: "pointer", padding: 0, fontSize: 11, fontWeight: 600, fontFamily: "inherit" }}
              >
                {showAllCmds ? "Show runnable methods only" : `Show all ${tierCmds.length} methods`}
              </button>
            )}
            {selected && (
              <div className="gw-row" style={{ gap: 7, marginTop: 6, alignItems: "center" }}>
                <span className="gw-mono" style={{ fontSize: 11, color: "var(--text-3)" }}>
                  {commandSignature(iface, selected.command)}
                </span>
                {/* The head is sendable as-is; everything else is either
                    known to need input or unproven, and says so rather than
                    letting Send fail with an unexplained RPC error. */}
                {selected.command.needsInput && (
                  <span
                    className="gw-tag"
                    title="This method takes arguments the catalog can't supply — fill the params in below before sending."
                    style={{ fontSize: 10, color: "var(--warn)", background: "rgba(251,191,36,0.10)", borderColor: "rgba(251,191,36,0.25)" }}
                  >
                    needs params
                  </span>
                )}
                {/* Which version of the API this one belongs to. The spec
                    splits some interfaces across internal paths and the name
                    alone doesn't say which — `/estimateFee` is a TON v2 call
                    and a v3 call, with different bodies. */}
                {selected.command.internalPath && (
                  <span
                    className="gw-tag"
                    title={`Served by this chain's ${selected.command.internalPath} collection. You still send the name as it stands — the router dials the upstream pinned to that path.`}
                    style={{ fontSize: 10 }}
                  >
                    {selected.command.internalPath}
                  </span>
                )}
                {/* The same name under two internal paths. The router's REST
                    lookup is keyed by (name, verb) with no path, so it can
                    only ever resolve to one of them — which one is the spec's
                    collection order, not something the caller chooses. */}
                {selected.command.ambiguous && !onDirect && (
                  <span
                    className="gw-tag"
                    title={`This chain declares ${commandKey(iface, selected.command)} under more than one internal path. The router matches the name alone, so it reaches only one of them — send it direct to pick the other.`}
                    style={{ fontSize: 10, color: "var(--warn)", background: "rgba(251,191,36,0.10)", borderColor: "rgba(251,191,36,0.25)" }}
                  >
                    one of two
                  </span>
                )}
              </div>
            )}
            {selected?.command.desc && (
              <div
                style={{
                  fontSize: 11.5,
                  color: "var(--text-3)",
                  marginTop: 4,
                  lineHeight: 1.5,
                }}
              >
                {selected.command.desc}
              </div>
            )}
          </div>

          <div>
            <div style={SECTION_LABEL}>{paramsLabel}</div>
            <textarea
              value={paramsText}
              onChange={(e) => setParamsText(e.target.value)}
              spellCheck={false}
              rows={paramsKindFor(iface) === "json" ? 6 : 2}
              style={{
                ...FIELD_INPUT,
                resize: "vertical",
                lineHeight: 1.6,
              }}
            />
            {buildError && (
              <div
                style={{ fontSize: 11, color: "var(--err)", marginTop: 6 }}
                role="alert"
              >
                {buildError}
              </div>
            )}
          </div>
          </>
          )}

          {canFire ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="gw-row" style={{ gap: 10, alignItems: "center" }}>
                <span
                  title={
                    directPathRefusal ??
                    (pinRefusal !== null && !onDirect ? (pinHint ?? undefined) : undefined)
                  }
                  style={{ display: "inline-flex" }}
                >
                <button
                  type="button"
                  className="gw-btn gw-btn--primary"
                  onClick={send}
                  // Off with the router leg: on a backup row with nothing the
                  // api can dial (a ws transport this node has no url for),
                  // the drawer has no send that could land.
                  disabled={
                    !resolved ||
                    status === "loading" ||
                    (pinRefusal !== null && !onDirect) ||
                    directPathRefusal !== null
                  }
                  style={{ padding: "9px 16px", fontSize: 13, fontWeight: 500, gap: 7 }}
                >
                  {status === "loading" ? (
                    <>
                      <Spinner /> Sending…
                    </>
                  ) : (
                    <>
                      <IconZap size={13} /> Send{onDirect ? " direct" : ""}
                    </>
                  )}
                </button>
                </span>
                {/* Both paths, one click — the comparison is the reason the
                    direct mode is worth having, so it lives WITH that mode.
                    In router mode there is no second leg to compare against,
                    and on a backup the router leg cannot be aimed at THIS
                    upstream, so there is no pair to put side by side — the
                    control is absent rather than present-and-refusing. */}
                {onDirect && !pinRefusal && !directPathRefusal && (
                  <button
                    type="button"
                    className="gw-btn gw-btn--ghost"
                    onClick={compareBoth}
                    title="Send the same request through the router AND straight to the upstream, then show both answers side by side."
                    disabled={!resolved || status === "loading"}
                    style={{ padding: "9px 14px", fontSize: 12, fontWeight: 500, gap: 6 }}
                  >
                    {comparing ? (
                      <>
                        <Spinner /> Comparing…
                      </>
                    ) : (
                      <>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v18"/><path d="M16 3v18"/><path d="M3 8h18"/><path d="M3 16h18"/></svg>
                        Compare both
                      </>
                    )}
                  </button>
                )}
                {/* Router HTTP sends only — the directive is a request header,
                    which a browser WebSocket handshake can't carry, and the
                    direct leg has no router cache to skip. Kept visible in
                    direct mode because "Compare both" still fires a router
                    leg, which honours it; gone when there is no router leg at
                    all (a backup the router refuses to pin). */}
                {!onWs && pinRefusal === null && (
                  <label
                    title="Send with the lava-force-cache-refresh header — the router bypasses its relay cache and asks an upstream even when a cached answer exists (no more 'Cached' in Served by). Applies to sends through the router."
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-2)", cursor: "pointer", userSelect: "none" }}
                  >
                    <input
                      type="checkbox"
                      checked={skipCache}
                      onChange={(e) => setSkipCache(e.target.checked)}
                      style={{ accentColor: "var(--brand)" }}
                    />
                    Skip cache
                  </label>
                )}
                {wsPhase && (
                  <span
                    className="gw-tag"
                    style={{
                      fontSize: 11,
                      gap: 5,
                      display: "inline-flex",
                      alignItems: "center",
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background:
                          wsPhase === "open" ? "var(--ok, #4ade80)" : "var(--warn, #fbbf24)",
                        boxShadow:
                          wsPhase === "open"
                            ? "0 0 6px rgba(74,222,128,0.7)"
                            : "0 0 4px rgba(251,191,36,0.6)",
                        animation:
                          wsPhase === "connecting"
                            ? "tryme-pulse 1s ease-in-out infinite"
                            : undefined,
                      }}
                    />
                    <style>{`@keyframes tryme-pulse{0%,100%{opacity:1}50%{opacity:.35}}`}</style>
                    {wsPhase === "connecting" ? "Connecting…" : "Socket open"}
                  </span>
                )}
                {latencyMs !== null && (
                  <span
                    className={
                      status === "ok" ? "gw-tag gw-tag--ok" : "gw-tag gw-tag--err"
                    }
                    style={{ fontSize: 11 }}
                    title={
                      resultVia === "upstream"
                        ? "Measured at the dashboard api, around its call to the upstream — a different pair of hops than the router number."
                        : "Measured in the browser, around the call to the router."
                    }
                  >
                    {httpStatus !== null ? `${httpStatus} · ` : ""}
                    {latencyMs} ms
                  </span>
                )}
                {/* A direct result carries no router telemetry — say so,
                    rather than leaving the row looking like a relay whose
                    headers happened to be unreadable. */}
                {resultVia === "upstream" && (
                  <span
                    className="gw-tag"
                    title="Answered by the upstream itself. The router was not in the path, so there is no cache status, no retry count and no cross-validation to report."
                    style={{ fontSize: 11, color: "var(--brand)", background: "rgba(255,57,0,0.10)", borderColor: "rgba(255,57,0,0.25)", display: "inline-flex", alignItems: "center", gap: 4 }}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                    direct · no router
                  </span>
                )}
                {truncated && (
                  <span
                    className="gw-tag"
                    title="The upstream's response was larger than the relay's size cap and was cut off."
                    style={{ fontSize: 11, color: "var(--warn)", background: "rgba(251,191,36,0.10)", borderColor: "rgba(251,191,36,0.25)" }}
                  >
                    truncated
                  </span>
                )}
                {/* Which upstream served the relay (Lava-Provider-Address).
                    "Cached" → the router answered from its cache; otherwise the
                    real upstream name(s). Shown only when the header is
                    readable — never guessed. */}
                {servedBy && (() => {
                  const isCached = /(^|,)\s*Cached\s*$/i.test(servedBy);
                  const upstreams = servedBy
                    .split(",")
                    .map((s) => s.trim())
                    .filter((s) => s && !/^Cached$/i.test(s));
                  if (isCached) {
                    return (
                      <span
                        className="gw-tag"
                        title="Served from the router's cache (Lava-Provider-Address: Cached)"
                        style={{ fontSize: 11, color: "#22d3ee", background: "rgba(34,211,238,0.12)", borderColor: "rgba(34,211,238,0.25)", display: "inline-flex", alignItems: "center", gap: 4 }}
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>
                        cached{upstreams.length ? ` · ${upstreams.join(", ")}` : ""}
                      </span>
                    );
                  }
                  return (
                    <span
                      className="gw-tag"
                      title="Upstream that served this relay (Lava-Provider-Address)"
                      style={{ fontSize: 11, color: "var(--text-3)", display: "inline-flex", alignItems: "center", gap: 4, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/></svg>
                      via {upstreams.join(", ") || servedBy}
                    </span>
                  );
                })()}
                {/* Retry indicator — the router's Lava-Retries header counts how
                    many times this relay was retried before the answer you got. */}
                {retries !== null && retries > 0 && (
                  <span
                    className="gw-tag"
                    title={`This relay was retried ${retries}× before succeeding (Lava-Retries)`}
                    style={{ fontSize: 11, color: "var(--warn)", background: "rgba(251,191,36,0.10)", borderColor: "rgba(251,191,36,0.25)", display: "inline-flex", alignItems: "center", gap: 4 }}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                    retried {retries}×
                  </span>
                )}
                {/* Cross-validation outcome. The router CORS-exposes only the
                    agreeing/disagreeing provider lists (plus Lava-Retries) —
                    NOT Lava-Cross-Validation-Status — so the badge keys on
                    those; a browser can never read the status header. */}
                {(cvStatus || cvAgreeing || cvDisagreeing) && (() => {
                  const disagreed = !!(cvDisagreeing && cvDisagreeing.trim());
                  const ok = !disagreed && cvStatus !== "failed";
                  return (
                    <span
                      className="gw-tag"
                      title={`Cross-validated${cvStatus ? ` · ${cvStatus}` : ""}${cvAgreeing ? ` · agreeing: ${cvAgreeing}` : ""}${disagreed ? ` · disagreeing: ${cvDisagreeing}` : ""}`}
                      style={{ fontSize: 11, color: ok ? "var(--ok)" : "var(--warn)", background: ok ? "rgba(34,197,94,0.10)" : "rgba(251,191,36,0.10)", borderColor: ok ? "rgba(34,197,94,0.25)" : "rgba(251,191,36,0.25)", display: "inline-flex", alignItems: "center", gap: 4, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
                      cross-validated{cvAgreeing ? ` · ${cvAgreeing}` : ""}{disagreed ? ` · disagreed: ${cvDisagreeing}` : ""}
                    </span>
                  );
                })()}
              </div>
            </div>
          ) : flat.length === 0 ? null : (
            // gRPC needs HTTP/2 trailers (not exposed to fetch) and gRPC-Web
            // needs protobuf encoding. Show the snippets but disable Send.
            <div style={INFO_BANNER}>
              <IconInfo size={13} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                {iface === "grpc-web" ? "gRPC-Web" : "gRPC"} can't be dialed
                directly from the browser. Use the {codeTab} snippet below to
                run this from your terminal or app.
              </span>
            </div>
          )}

          {/* Side-by-side outcome of "Compare both" — the router's path next
              to the upstream's own answer. */}
          {comparison && (() => {
            const same = stableStringify(comparison.router.body) === stableStringify(comparison.upstream.body);
            const delta = comparison.router.latencyMs - comparison.upstream.latencyMs;
            const rows: { label: string; hint: string; out: Outcome }[] = [
              {
                label: "Via router",
                hint: selectUpstream ? `pinned to ${selectUpstream}` : "router picks the upstream",
                out: comparison.router,
              },
              {
                label: "Direct to upstream",
                hint: directHost ?? "upstream",
                out: comparison.upstream,
              },
            ];
            return (
              <div>
                <div style={SECTION_LABEL}>Comparison</div>
                <div style={{ border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
                  {rows.map((row, i) => (
                    <div
                      key={row.label}
                      className="gw-row"
                      style={{
                        gap: 10,
                        padding: "8px 12px",
                        borderTop: i === 0 ? undefined : "1px solid var(--line)",
                        background: i === 0 ? "var(--hover)" : "transparent",
                      }}
                    >
                      <span style={{ fontSize: 12, fontWeight: 500, minWidth: 150 }}>{row.label}</span>
                      <span className="gw-mono" style={{ fontSize: 11, color: "var(--text-3)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {row.hint}
                      </span>
                      <span className={row.out.errored ? "gw-tag gw-tag--err" : "gw-tag gw-tag--ok"} style={{ fontSize: 11 }}>
                        {row.out.httpStatus !== null ? `${row.out.httpStatus} · ` : ""}{row.out.latencyMs} ms
                      </span>
                      {row.out.servedBy && (
                        <span className="gw-tag" style={{ fontSize: 11, color: "var(--text-3)", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {row.out.servedBy}
                        </span>
                      )}
                    </div>
                  ))}
                  <div style={{ padding: "8px 12px", borderTop: "1px solid var(--line)", fontSize: 11, color: "var(--text-2)", lineHeight: 1.55 }}>
                    <strong style={{ color: same ? "var(--ok)" : "var(--warn)" }}>
                      {same ? "Identical response bodies." : "Response bodies differ."}
                    </strong>{" "}
                    {same
                      ? "The router relayed the upstream's answer unchanged."
                      : "Expected for anything that tracks the head (block number, latest block, gas price) — the two calls are moments apart. For a fixed-height read, a difference is worth looking at."}{" "}
                    The router leg ran first and took{" "}
                    <strong style={{ color: "var(--text)" }}>
                      {delta === 0 ? "the same time" : `${Math.abs(delta)} ms ${delta > 0 ? "longer" : "less"}`}
                    </strong>
                    , but the two are measured from different places — the browser for the router, the api for the upstream — so read the gap as a hint, not a benchmark.
                  </div>
                </div>
                {/* The two bodies, side by side. "Do these agree?" is the
                    question the whole mode exists for, and answering it from
                    one rendered body plus a sentence asserting the other one
                    differs asks the reader to take our word for it. Both are
                    on screen; the note above says which way to read them. */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
                  {rows.map((row) => (
                    <div key={row.label} style={{ minWidth: 0 }}>
                      <div className="gw-row" style={{ justifyContent: "space-between", marginBottom: 6, gap: 8 }}>
                        <div style={{ ...SECTION_LABEL, marginBottom: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {row.label}
                        </div>
                        <CopyButton text={JSON.stringify(row.out.body, null, 2)} label="Copy" />
                      </div>
                      <JsonDisplay data={row.out.body} maxHeight={260} />
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {snippets && (
            <div>
              <div style={SECTION_LABEL}>Code</div>
              <Tabs tabs={CODE_TABS} active={codeTab} setActive={setCodeTab} />
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {blocksForTab(snippets, codeTab).map((block, i) => (
                  <div key={i}>
                    {block.label && <div style={BLOCK_LABEL}>{block.label}</div>}
                    <CodeBlock code={block.code} language={block.language} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Suppressed while a comparison is on screen — its router column
              already IS this body, and printing it again below reads as a
              third, separate answer. */}
          {response !== null && comparison === null && (
            <div>
              <div
                className="gw-row"
                style={{ justifyContent: "space-between", marginBottom: 6 }}
              >
                <div style={{ ...SECTION_LABEL, marginBottom: 0 }}>Response</div>
                <CopyButton
                  text={JSON.stringify(response, null, 2)}
                  label="Copy JSON"
                />
              </div>
              <JsonDisplay data={response} />
            </div>
          )}
        </div>
      </div>
    </>
  );

  return createPortal(drawer, document.body);
}
