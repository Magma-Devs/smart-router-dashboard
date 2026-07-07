/**
 * Resolve a (catalog command, user-edited params) pair into a concrete request
 * the drawer can fire (HTTP / WS) or hand to a snippet renderer (gRPC).
 *
 *  - `jsonrpc` / `tendermintrpc`           → POST a JSON-RPC envelope.
 *  - `jsonrpc-ws` / `tendermintrpc-ws`     → same envelope sent over WebSocket.
 *  - `rest`                                → GET endpointUrl + path.
 *  - `grpc` / `grpc-web`                   → snippets-only; we still resolve
 *                                             service+method+JSON-body so the
 *                                             snippet generators can render.
 */
import type { AddonCommand, CatalogInterface } from "./chain-methods";

export interface ResolvedHttp {
  transport: "http";
  httpMethod: "GET" | "POST";
  url: string;
  body: unknown | null;
  contentType: string | null;
}

export interface ResolvedWs {
  transport: "ws";
  url: string;
  /** JSON-RPC envelope — same shape we'd POST for `jsonrpc` / `tendermintrpc`. */
  body: unknown;
}

export interface ResolvedGrpc {
  transport: "grpc" | "grpc-web";
  /** Dial address — gRPC: `host:port` (no scheme). gRPC-Web: `http(s)://host`. */
  url: string;
  /** Fully-qualified service, e.g. `cosmos.base.tendermint.v1beta1.Service`. */
  service: string;
  /** Bare method name, e.g. `GetLatestBlock`. */
  methodName: string;
  /** `service/method` (grpcurl-style), with no leading slash. */
  fqMethod: string;
  /** JSON request message. */
  body: unknown;
}

export type ResolvedRequest = ResolvedHttp | ResolvedWs | ResolvedGrpc;

export type BuildRequestResult =
  | { ok: true; request: ResolvedRequest }
  | { ok: false; error: string };

/** Trim a single trailing slash so `url + path` doesn't double up. */
function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** Parse `/svc.Pkg.Service/MethodName` → `{ service, methodName, fqMethod }`. */
function parseGrpcMethod(
  raw: string,
): { service: string; methodName: string; fqMethod: string } | null {
  const stripped = raw.startsWith("/") ? raw.slice(1) : raw;
  const lastSlash = stripped.lastIndexOf("/");
  if (lastSlash <= 0 || lastSlash === stripped.length - 1) return null;
  const service = stripped.slice(0, lastSlash);
  const methodName = stripped.slice(lastSlash + 1);
  return { service, methodName, fqMethod: `${service}/${methodName}` };
}

function parseJsonParams(paramsText: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = paramsText.trim();
  if (trimmed === "") return { ok: true, value: [] };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Params must be valid JSON: ${msg}` };
  }
}

export function buildRequest(
  iface: CatalogInterface,
  command: AddonCommand,
  paramsText: string,
  endpointUrl: string,
): BuildRequestResult {
  if (iface === "rest") {
    const path = paramsText.trim();
    if (path && !path.startsWith("/")) {
      return { ok: false, error: "REST path must start with '/'" };
    }
    return {
      ok: true,
      request: {
        transport: "http",
        httpMethod: "GET",
        url: stripTrailingSlash(endpointUrl) + path,
        body: null,
        contentType: null,
      },
    };
  }

  if (iface === "grpc" || iface === "grpc-web") {
    const parsed = parseJsonParams(paramsText);
    if (!parsed.ok) return parsed;
    // Catalog params for gRPC are an object (`{}`, `{"height":"…"}`). An empty
    // textarea collapses to `[]` in parseJsonParams — convert to `{}` so the
    // snippet renders the expected empty-message shape.
    const body =
      Array.isArray(parsed.value) && parsed.value.length === 0 ? {} : parsed.value;
    const parts = parseGrpcMethod(command.method);
    if (!parts) {
      return {
        ok: false,
        error: `Malformed gRPC method "${command.method}" — expected "/service/Method".`,
      };
    }
    return {
      ok: true,
      request: {
        transport: iface,
        url: endpointUrl,
        service: parts.service,
        methodName: parts.methodName,
        fqMethod: parts.fqMethod,
        body,
      },
    };
  }

  // jsonrpc / tendermintrpc + their -ws variants — all carry the same
  // JSON-RPC 2.0 envelope. Only the transport differs.
  const parsed = parseJsonParams(paramsText);
  if (!parsed.ok) return parsed;
  const envelope = { jsonrpc: "2.0", id: 1, method: command.method, params: parsed.value };
  if (iface === "jsonrpc-ws" || iface === "tendermintrpc-ws") {
    return {
      ok: true,
      request: { transport: "ws", url: endpointUrl, body: envelope },
    };
  }
  return {
    ok: true,
    request: {
      transport: "http",
      httpMethod: "POST",
      url: endpointUrl,
      body: envelope,
      contentType: "application/json",
    },
  };
}

/** Whether the params textarea should be parsed as JSON or treated as a path. */
export function paramsKindFor(iface: CatalogInterface): "json" | "path" {
  return iface === "rest" ? "path" : "json";
}
