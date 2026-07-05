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
import { buildChainMetaByIndex, type HealthState } from "@sr/shared";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { CopyButton } from "@/components/gateway/CopyButton";
import {
  buildRequest,
  paramsKindFor,
  type ResolvedRequest,
} from "./build-request";
import {
  ifaceCanFire,
  TIER_ORDER,
  listMethods,
  type AddonCommand,
  type CatalogInterface,
  type InterfaceConfig,
  type Tier,
} from "./chain-methods";
import { CodeBlock } from "./code-block";
import { JsonDisplay } from "./json-display";
import { snippetsFor, type SnippetBlock, type Snippets } from "./snippets";

type CodeTab = "CLI" | "Python" | "Go" | "JavaScript";
type Status = "idle" | "loading" | "ok" | "error";
type WsPhase = "connecting" | "open" | null;

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
  iface: CatalogInterface;
  cfg: InterfaceConfig;
  endpointUrl: string;
  /** Live health from /api/metrics/chains, when the page has it. The status
   *  tag is omitted entirely when undefined — never a hardcoded status. */
  health?: HealthState;
  onClose: () => void;
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

function healthTagClass(health: HealthState): string {
  if (health === "operational") return "gw-tag gw-tag--ok";
  if (health === "unhealthy") return "gw-tag gw-tag--err";
  return "gw-tag";
}

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
  iface,
  cfg,
  endpointUrl,
  health,
  onClose,
}: TryMeDrawerProps) {
  const chain = buildChainMetaByIndex(spec);
  const flat = useMemo(() => listMethods(cfg), [cfg]);
  /** Tiers in render order that actually have methods on this iface. */
  const availableTiers = useMemo(
    () => TIER_ORDER.filter((t) => (cfg[t]?.length ?? 0) > 0),
    [cfg],
  );
  const first = flat[0];

  const canFire = ifaceCanFire(iface);

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
  const [response, setResponse] = useState<unknown>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [httpStatus, setHttpStatus] = useState<number | null>(null);
  const [wsPhase, setWsPhase] = useState<WsPhase>(null);
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

  const handleSelect = (next: string) => {
    setSelKey(next);
    const parsed = parseKey(next);
    if (!parsed) return;
    const cmd = flat.find((m) => m.tier === parsed.tier && m.index === parsed.index);
    if (cmd) setParamsText(defaultParamsFor(cmd.command, iface));
    setStatus("idle");
    setResponse(null);
    setLatencyMs(null);
    setHttpStatus(null);
  };

  const handleTierChange = (tier: Tier) => {
    setSelectedTier(tier);
    // Snap selection to the first method in the newly-selected tier so
    // the command dropdown lands on a real value rather than ""/empty.
    if ((cfg[tier]?.length ?? 0) > 0) {
      handleSelect(keyOf(tier, 0));
    }
  };

  const built = useMemo(() => {
    if (!selected) return null;
    return buildRequest(iface, selected.command, paramsText, endpointUrl);
  }, [selected, paramsText, endpointUrl, iface]);

  const resolved: ResolvedRequest | null = built && built.ok ? built.request : null;
  const buildError: string | null = built && !built.ok ? built.error : null;

  const snippets = useMemo<Snippets | null>(
    () => (resolved ? snippetsFor(resolved) : null),
    [resolved],
  );

  const send = useCallback(async () => {
    if (!resolved) return;
    setStatus("loading");
    setResponse(null);
    setLatencyMs(null);
    setHttpStatus(null);
    setWsPhase(null);
    const t0 = performance.now();
    try {
      switch (resolved.transport) {
        case "grpc":
        case "grpc-web":
          // Snippets-only — the UI hides Send for these. Defensive no-op.
          setStatus("idle");
          return;
        case "ws": {
          setWsPhase("connecting");
          const { json, errored, latencyMs } = await sendWebSocket(
            resolved.url,
            resolved.body,
            { onOpen: () => setWsPhase("open") },
          );
          setWsPhase(null);
          setLatencyMs(latencyMs);
          setHttpStatus(null);
          setStatus(errored ? "error" : "ok");
          setResponse(json);
          return;
        }
        case "http": {
          const init: RequestInit =
            resolved.httpMethod === "POST"
              ? {
                  method: "POST",
                  headers: {
                    "Content-Type": resolved.contentType ?? "application/json",
                  },
                  body: JSON.stringify(resolved.body),
                }
              : {};
          const res = await fetch(resolved.url, init);
          const dt = Math.round(performance.now() - t0);
          let json: unknown;
          try {
            json = await res.clone().json();
          } catch {
            const text = await res.text();
            json = { _raw: text };
          }
          setLatencyMs(dt);
          setHttpStatus(res.status);
          const errored =
            !res.ok ||
            (typeof json === "object" && json !== null && "error" in json);
          setStatus(errored ? "error" : "ok");
          setResponse(json);
          return;
        }
      }
    } catch (e) {
      setWsPhase(null);
      setLatencyMs(Math.round(performance.now() - t0));
      setStatus("error");
      setResponse({ error: { message: e instanceof Error ? e.message : String(e) } });
    }
  }, [resolved]);

  if (!mounted) return null;

  const paramsLabel = paramsKindFor(iface) === "json" ? "Params (JSON)" : "Path";

  const drawer = (
    <>
      <div
        onClick={close}
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
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          zIndex: 41,
          width: "min(640px, 100vw)",
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
          {health !== undefined && (
            <span className={healthTagClass(health)} style={{ fontSize: 10 }}>
              {health}
            </span>
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
            >
              {endpointUrl}
            </span>
            <CopyButton text={endpointUrl} />
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

          <div>
            <div style={SECTION_LABEL}>Command</div>
            <select
              value={selKey}
              onChange={(e) => handleSelect(e.target.value)}
              style={{ ...FIELD_INPUT, fontSize: 12 }}
            >
              {(cfg[selectedTier] ?? []).map((cmd, i) => (
                <option key={i} value={keyOf(selectedTier, i)}>
                  {cmd.label === cmd.method ? cmd.label : `${cmd.label} · ${cmd.method}`}
                </option>
              ))}
            </select>
            {selected && (
              <div
                className="gw-mono"
                style={{ fontSize: 11, color: "var(--text-3)", marginTop: 6 }}
              >
                {selected.command.method}
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

          {canFire ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="gw-row" style={{ gap: 10, alignItems: "center" }}>
                <button
                  type="button"
                  className="gw-btn gw-btn--primary"
                  onClick={send}
                  disabled={!resolved || status === "loading"}
                  style={{ padding: "9px 16px", fontSize: 13, fontWeight: 500, gap: 7 }}
                >
                  {status === "loading" ? (
                    <>
                      <Spinner /> Sending…
                    </>
                  ) : (
                    <>
                      <IconZap size={13} /> Send
                    </>
                  )}
                </button>
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
                  >
                    {httpStatus !== null ? `${httpStatus} · ` : ""}
                    {latencyMs} ms
                  </span>
                )}
              </div>
            </div>
          ) : (
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

          {response !== null && (
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
