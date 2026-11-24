import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AskSettings } from "../../config.js";
import { AskFailure, abortFailure } from "./errors.js";
import { boundedFetch } from "./http.js";
import {
  hasBoundedAskQuery,
  LOGS_LOOKBACK_SECONDS,
  METRICS_LOOKBACK_SECONDS,
} from "./query-bounds.js";
import { isoSeconds, isoTime } from "./request-summary.js";

const identifier = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const metricsQuery = z
  .string()
  .min(1)
  .max(16_000)
  .refine((q) => hasBoundedAskQuery(q, METRICS_LOOKBACK_SECONDS));
const logsQuery = z
  .string()
  .min(1)
  .max(16_000)
  .refine((q) => hasBoundedAskQuery(q, LOGS_LOOKBACK_SECONDS));
const timestamp = z.number().finite().nonnegative();
const windowShape = { start: timestamp, end: timestamp };
const rangeValid = (p: { start: number; end: number }) =>
  p.end >= p.start && p.end - p.start <= 86_400;
const range = z.object(windowShape).strict().refine(rangeValid);
const label = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,199}$/);
const metric = z.string().regex(/^[a-zA-Z_:][a-zA-Z0-9_:]{0,199}$/);
const limit = z.number().int().min(1).max(1000).optional();

/** Local audited policy. Remote annotations/catalog claims cannot add operations. */
const readPolicy: Record<string, { kinds: string[]; parameters: z.ZodType }> = {
  "metrics.query": {
    kinds: ["mimir", "prometheus"],
    parameters: z.object({ query: metricsQuery, time: timestamp.optional() }).strict(),
  },
  "metrics.query_range": {
    kinds: ["mimir", "prometheus"],
    parameters: z
      .object({ query: metricsQuery, ...windowShape, step: z.number().min(1).max(86_400) })
      .strict()
      .refine((p) => rangeValid(p) && (p.end - p.start) / p.step <= 11_000),
  },
  "metrics.labels": { kinds: ["mimir", "prometheus"], parameters: range },
  "metrics.label_values": {
    kinds: ["mimir", "prometheus"],
    parameters: z
      .object({ label, ...windowShape })
      .strict()
      .refine(rangeValid),
  },
  "metrics.series": {
    kinds: ["mimir", "prometheus"],
    parameters: z
      .object({ match: z.array(metricsQuery).min(1).max(10), ...windowShape })
      .strict()
      .refine(rangeValid),
  },
  "metrics.metadata": {
    kinds: ["mimir", "prometheus"],
    parameters: z.object({ metric: metric.optional(), limit }).strict(),
  },
  "logs.query": {
    kinds: ["loki"],
    parameters: z.object({ query: logsQuery, time: timestamp.optional(), limit }).strict(),
  },
  "logs.query_range": {
    kinds: ["loki"],
    parameters: z
      .object({
        query: logsQuery,
        ...windowShape,
        limit,
        direction: z.enum(["forward", "backward"]).optional(),
        step: z.number().min(1).max(86_400).optional(),
      })
      .strict()
      .refine(rangeValid),
  },
  "logs.labels": { kinds: ["loki"], parameters: range },
  "logs.label_values": {
    kinds: ["loki"],
    parameters: z
      .object({ label, ...windowShape })
      .strict()
      .refine(rangeValid),
  },
  "logs.series": {
    kinds: ["loki"],
    parameters: z
      .object({ match: z.array(logsQuery).min(1).max(10), ...windowShape })
      .strict()
      .refine(rangeValid),
  },
  "grafana.search": {
    kinds: ["grafana"],
    parameters: z
      .object({
        query: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .strict(),
  },
  "grafana.dashboard": {
    kinds: ["grafana"],
    parameters: z.object({ uid: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/) }).strict(),
  },
  "status.chain_events": {
    kinds: ["provider_status"],
    parameters: z
      .object({
        since: timestamp.optional(),
        until: timestamp.optional(),
        include: z
          .array(z.enum(["current", "provider", "measured", "changes"]))
          .min(1)
          .max(4)
          .refine((v) => new Set(v).size === v.length)
          .optional(),
        horizonDays: z.number().int().min(1).max(90).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        before: z
          .string()
          .regex(/^[A-Za-z0-9_=-]{1,4096}$/)
          .optional(),
        chains: z
          .array(z.string().regex(/^[A-Z0-9]{2,32}$/))
          .min(1)
          .max(64)
          .optional(),
      })
      .strict()
      .refine((p) => {
        const now = Date.now() / 1000;
        const until = Math.floor(p.until ?? now);
        const since = Math.floor(p.since ?? until - 86_400);
        return (
          (!p.before || (p.since !== undefined && p.until !== undefined)) &&
          since >= 0 &&
          since <= now &&
          until > since &&
          until - since <= 7 * 86_400 &&
          until <= now + 300
        );
      }),
  },
};

/** Locally authored descriptions only. Remote catalog text never enters the
 * system prompt. Discovery can narrow, but cannot extend, this policy. */
export function askReadOperations() {
  return Object.entries(readPolicy).map(([operationId, policy]) => {
    if (!(policy.parameters instanceof z.ZodObject)) throw new AskFailure("ASK_UNAVAILABLE");
    const shape: Record<string, z.ZodType> = { ...policy.parameters.shape };
    for (const [seconds, iso] of Object.entries(ISO_TIMES)) {
      if (!(seconds in shape)) continue;
      shape[seconds] = shape[seconds]!.optional();
      shape[iso] = isoTime.optional();
    }
    return {
      operationId,
      toolName: operationId.replaceAll(".", "_"),
      // The policy's own checks run on the converted parameters (askReadParameters).
      inputSchema: z.object({ ...shape, sourceId: identifier.optional() }).strict(),
    };
  });
}

/** A time a read tool takes in Unix seconds, and the ISO 8601 field it also takes. */
const ISO_TIMES: Record<string, string> = {
  start: "from",
  end: "to",
  since: "from",
  until: "to",
  time: "at",
};

/**
 * A read tool's parameters with its ISO 8601 times (`from`, `to`, `at`) in the
 * Unix-second fields the read policy and the MCP server take. A time given
 * both ways is refused.
 */
export function askReadParameters(
  operationId: string,
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const policy = Object.hasOwn(readPolicy, operationId) ? readPolicy[operationId] : undefined;
  if (!(policy?.parameters instanceof z.ZodObject)) throw new AskFailure("ASK_TOOL_DENIED", 403);
  const fields = Object.keys(policy.parameters.shape);
  const result = { ...parameters };
  for (const iso of new Set(Object.values(ISO_TIMES))) delete result[iso];
  for (const [seconds, iso] of Object.entries(ISO_TIMES)) {
    if (!fields.includes(seconds) || parameters[iso] === undefined) continue;
    const parsed = isoTime.safeParse(parameters[iso]);
    if (!parsed.success || parameters[seconds] !== undefined)
      throw new AskFailure("ASK_TOOL_DENIED", 403);
    result[seconds] = isoSeconds(parsed.data);
  }
  return result;
}

export function assertAskRead(operationId: string, parameters: Record<string, unknown>): void {
  const policy = Object.hasOwn(readPolicy, operationId) ? readPolicy[operationId] : undefined;
  if (!policy?.parameters.safeParse(parameters).success)
    throw new AskFailure("ASK_TOOL_DENIED", 403);
}

const identitySchema = z
  .object({
    tenantId: identifier,
    subject: z.string().min(1).max(200),
    scopes: z.array(z.string()).max(20),
    access: z.enum(["customer", "staff"]).optional(),
    tenantIds: z.array(identifier).max(40).optional(),
  })
  .passthrough();
const sourceSchema = z
  .object({
    id: identifier,
    tenantId: identifier.optional(),
    name: z.string().max(120),
    kind: z.enum(["mimir", "prometheus", "loki", "grafana", "provider_status"]),
    operationIds: z.array(z.string().max(128)).max(64),
  })
  .passthrough();
const catalogSchema = z
  .object({
    version: z.string().max(120),
    sources: z
      .array(
        z
          .object({
            sourceId: identifier,
            tenantId: identifier.optional(),
            operations: z
              .array(
                z
                  .object({
                    id: z.string().max(128),
                    description: z.string().max(16_000),
                    method: z.string().max(10),
                    readOnly: z.boolean(),
                    inputSchema: z.record(z.string(), z.unknown()),
                  })
                  .passthrough(),
              )
              .max(64),
          })
          .passthrough(),
      )
      .max(40),
  })
  .passthrough();

export interface McpSource {
  id: string;
  name: string;
  kind: string;
  operationIds: string[];
}
export interface McpSnapshot {
  customerId: string;
  subject: string;
  tools: string[];
  catalogVersion: string;
  sources: McpSource[];
  operations: Array<{
    sourceId: string;
    operationId: string;
    inputSchema: Record<string, unknown>;
  }>;
}
/** A window in Unix seconds. */
export interface McpWindow {
  start: number;
  end: number;
}
export interface McpReadResult {
  sourceId: string;
  operationId: string;
  ok: boolean;
  data?: unknown;
  /** The MCP server's code for a read it did not answer. */
  error?: string;
  /** The MCP server's own words on what it read instead, or what to change. */
  guidance?: string;
  /** The read covers part of what was asked: the server narrowed it. */
  partial?: boolean;
  /** What was asked for and what the narrowed read covers. */
  window?: { requested: McpWindow; read: McpWindow };
  /** What the server ran in place of what was sent. */
  adjusted?: { step?: number; query?: string };
}

/** The longest guidance kept from the MCP server, in characters. */
export const MCP_GUIDANCE_MAX = 1200;
const errorCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const windowSchema = z.object({ start: timestamp, end: timestamp });
/** What a read says it did differently. Each part is read on its own, so a
 * part this version does not understand is dropped, never the read. */
const readNotes = {
  guidance: z.string().min(1).max(8000),
  partial: z.literal(true),
  window: z.object({ requested: windowSchema, read: windowSchema }),
  adjusted: z.object({
    step: z.number().positive().optional(),
    query: z.string().min(1).max(16_000).optional(),
  }),
};
function notesOf(envelope: Record<string, unknown>) {
  const guidance = readNotes.guidance.safeParse(envelope.guidance);
  const partial = readNotes.partial.safeParse(envelope.partial);
  const window = readNotes.window.safeParse(envelope.window);
  const adjusted = readNotes.adjusted.safeParse(envelope.adjusted);
  return {
    ...(guidance.success
      ? // Printable text only, and no longer than a tool result can spare.
        {
          guidance: guidance.data
            .replace(/[^\x20-\x7E]+/g, " ")
            .replace(/ {2,}/g, " ")
            .slice(0, MCP_GUIDANCE_MAX),
        }
      : {}),
    ...(partial.success ? { partial: true } : {}),
    ...(window.success ? { window: window.data } : {}),
    ...(adjusted.success && (adjusted.data.step !== undefined || adjusted.data.query !== undefined)
      ? { adjusted: adjusted.data }
      : {}),
  };
}

/** A read the MCP server refused as a tool error for what it asked, not for
 * who asked: the read failed, the connection and the identity did not. */
class RefusedRead {
  constructor(
    readonly error: string,
    readonly guidance?: string,
  ) {}
}
const REFUSED_AS_TOOL_ERROR = new Set(["INVALID_PARAMETERS"]);
function refusedRead(result: CallToolResult): RefusedRead | null {
  if (!result.isError) return null;
  const [first] = result.content;
  if (result.content.length !== 1 || first?.type !== "text") return null;
  let body: unknown;
  try {
    body = JSON.parse(first.text);
  } catch {
    return null;
  }
  const refusal = z
    .object({ error: errorCode, guidance: z.unknown().optional() })
    .passthrough()
    .safeParse(body);
  if (!refusal.success || !REFUSED_AS_TOOL_ERROR.has(refusal.data.error)) return null;
  return new RefusedRead(refusal.data.error, notesOf(refusal.data).guidance);
}

function unwrap(result: CallToolResult): unknown {
  if (result.isError) throw new AskFailure("ASK_MCP_UNAVAILABLE");
  if (
    typeof result.structuredContent === "object" &&
    result.structuredContent !== null &&
    "result" in result.structuredContent
  )
    return result.structuredContent.result;
  const [first] = result.content;
  if (result.content.length !== 1 || first?.type !== "text")
    throw new AskFailure("ASK_MCP_UNAVAILABLE");
  try {
    return JSON.parse(first.text) as unknown;
  } catch {
    throw new AskFailure("ASK_MCP_UNAVAILABLE");
  }
}

/** What runs that share a pooled client share: the discovery it made and a
 * way to retire the client after a failure. */
interface SharedDiscovery {
  snapshot: McpSnapshot | null;
  at: number;
  ttlMs: number;
  now: () => number;
  retire: () => void;
}

export class McpConnection {
  private snapshotValue: McpSnapshot | null = null;
  constructor(
    private readonly client: Client,
    private readonly settings: AskSettings,
    private readonly signal?: AbortSignal,
    private readonly shared?: SharedDiscovery,
  ) {}

  /** `refusals`: a tool error that refuses what was asked comes back as a
   * RefusedRead instead of ending the connection. */
  private async call(
    name: string,
    args: Record<string, unknown> = {},
    refusals = false,
  ): Promise<unknown> {
    try {
      const result = (await this.client.callTool(
        { name, arguments: args },
        { signal: this.signal, timeout: this.settings.requestTimeoutMs },
      )) as CallToolResult;
      return (refusals ? refusedRead(result) : null) ?? unwrap(result);
    } catch (error) {
      if (this.signal?.aborted) throw abortFailure(this.signal);
      this.shared?.retire();
      if (error instanceof AskFailure) throw error;
      throw new AskFailure("ASK_MCP_UNAVAILABLE");
    }
  }

  private mismatch(): never {
    this.shared?.retire();
    throw new AskFailure("ASK_IDENTITY_MISMATCH");
  }

  private async verifyIdentity(): Promise<string> {
    const identity = identitySchema.safeParse(await this.call("whoami"));
    if (
      !identity.success ||
      identity.data.tenantId !== this.settings.customerId ||
      identity.data.access === "staff" ||
      !identity.data.scopes.includes("read") ||
      identity.data.scopes.some((scope) => scope !== "read") ||
      (identity.data.tenantIds &&
        (identity.data.tenantIds.length !== 1 ||
          identity.data.tenantIds[0] !== this.settings.customerId))
    ) {
      this.mismatch();
    }
    return identity.data.subject;
  }

  /** A pooled client's discovery is reused until it is `ttlMs` old; every read
   * still verifies this credential's identity with the MCP server. */
  async discover(): Promise<McpSnapshot> {
    const shared = this.shared;
    if (shared?.snapshot && shared.now() - shared.at < shared.ttlMs) {
      this.snapshotValue = shared.snapshot;
      return structuredClone(shared.snapshot);
    }
    const snapshot = await this.discoverNow();
    if (shared) {
      shared.snapshot = snapshot;
      shared.at = shared.now();
    }
    return structuredClone(snapshot);
  }

  private async discoverNow(): Promise<McpSnapshot> {
    const subject = await this.verifyIdentity();
    const [rawSources, rawCatalog, tools] = await Promise.all([
      this.call("list_sources"),
      this.call("search_operations"),
      this.client.listTools({}, { signal: this.signal, timeout: this.settings.requestTimeoutMs }),
    ]);
    const sources = z.array(sourceSchema).max(40).safeParse(rawSources);
    const catalog = catalogSchema.safeParse(rawCatalog);
    if (!sources.success || !catalog.success) throw new AskFailure("ASK_MCP_UNAVAILABLE");
    if (
      sources.data.some(
        (s) => s.tenantId !== undefined && s.tenantId !== this.settings.customerId,
      ) ||
      catalog.data.sources.some(
        (s) => s.tenantId !== undefined && s.tenantId !== this.settings.customerId,
      ) ||
      new Set(sources.data.map((s) => s.id)).size !== sources.data.length ||
      new Set(catalog.data.sources.map((s) => s.sourceId)).size !== catalog.data.sources.length ||
      catalog.data.sources.some((s) => !sources.data.some((source) => source.id === s.sourceId))
    ) {
      this.mismatch();
    }
    // Keep the catalog as data, not instructions. Only the local policy can
    // admit an operation; discovery narrows it to this credential's grant.
    const snapshot: McpSnapshot = {
      customerId: this.settings.customerId,
      subject,
      tools: tools.tools.map((t) => t.name),
      catalogVersion: catalog.data.version,
      sources: sources.data.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        operationIds: s.operationIds.filter((id) => {
          const policy = Object.hasOwn(readPolicy, id) ? readPolicy[id] : undefined;
          const remote = catalog.data.sources
            .find((entry) => entry.sourceId === s.id)
            ?.operations.find((op) => op.id === id);
          return (
            policy?.kinds.includes(s.kind) && remote?.method === "GET" && remote.readOnly === true
          );
        }),
      })),
      operations: [],
    };
    // The model sees only locally authored schemas, never remote tool
    // descriptions as instructions. Runtime refinements are enforced again.
    snapshot.operations = snapshot.sources.flatMap((source) =>
      source.operationIds.map((operationId) => ({
        sourceId: source.id,
        operationId,
        inputSchema: z.toJSONSchema(readPolicy[operationId]!.parameters) as Record<string, unknown>,
      })),
    );
    if (!snapshot.tools.includes("execute_operation")) {
      this.shared?.retire();
      throw new AskFailure("ASK_MCP_UNAVAILABLE");
    }
    this.snapshotValue = snapshot;
    return snapshot;
  }

  async read(
    sourceId: string,
    operationId: string,
    parameters: Record<string, unknown>,
  ): Promise<McpReadResult> {
    const snapshot = this.snapshotValue ?? (await this.discover());
    const source = snapshot.sources.find((s) => s.id === sourceId);
    const policy = Object.hasOwn(readPolicy, operationId) ? readPolicy[operationId] : undefined;
    const parsed = policy?.parameters.safeParse(parameters);
    if (!source || !source.operationIds.includes(operationId) || !parsed?.success)
      throw new AskFailure("ASK_TOOL_DENIED", 403);
    // Do not accept a changed/revoked grant merely because discovery once
    // worked. The identity check and the read go out together; the read's
    // result is used only once the identity check has passed.
    const [identity, executed] = await Promise.allSettled([
      this.verifyIdentity(),
      this.call("execute_operation", { sourceId, operationId, parameters: parsed.data }, true),
    ]);
    if (identity.status === "rejected") throw identity.reason;
    if (executed.status === "rejected") throw executed.reason;
    if (executed.value instanceof RefusedRead)
      return {
        sourceId,
        operationId,
        ok: false,
        error: executed.value.error,
        ...(executed.value.guidance ? { guidance: executed.value.guidance } : {}),
      };
    const result = z
      .object({
        // The MCP server picks the tenant from this credential; an envelope
        // that names one must name this customer.
        tenantId: identifier.optional(),
        sourceId: identifier,
        operationId: z.string(),
        ok: z.boolean(),
        data: z.unknown().optional(),
        error: z.string().max(128).optional(),
      })
      .passthrough()
      .safeParse(executed.value);
    if (!result.success) throw new AskFailure("ASK_MCP_UNAVAILABLE");
    if (
      (result.data.tenantId !== undefined && result.data.tenantId !== this.settings.customerId) ||
      result.data.sourceId !== sourceId ||
      result.data.operationId !== operationId
    )
      this.mismatch();
    return {
      sourceId,
      operationId,
      ok: result.data.ok,
      data: result.data.data,
      error: result.data.error,
      ...notesOf(result.data),
    };
  }
}

/** Each invocation gets a fresh immutable customer connection. No fleet fallback. */
export class McpAdapter {
  constructor(
    private readonly settings: AskSettings,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  /** The connected client before a run's view is put on it. `signal` bounds
   * the connection's own requests; a pooled client's is the pool's, so one
   * run's stop cannot cut another run's request. */
  async connect(signal: AbortSignal): Promise<Client> {
    if (!this.settings.enabled) throw new AskFailure("ASK_DISABLED", 404);
    if (this.settings.problem) throw new AskFailure("ASK_UNAVAILABLE");
    const endpoint = new URL(this.settings.mcpUrl).toString();
    const client = new Client(
      { name: "smart-router-dashboard", version: "1" },
      { capabilities: {}, versionNegotiation: { mode: "legacy" } },
    );
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: {
        headers: { authorization: `Bearer ${this.settings.mcpToken}` },
        redirect: "error",
      },
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.url !== endpoint) throw new AskFailure("ASK_TOOL_DENIED", 403);
        const body = request.method === "POST" ? await request.text() : undefined;
        if (body && Buffer.byteLength(body) > this.settings.maxContextBytes)
          throw new AskFailure("ASK_LIMIT_REACHED", 422);
        return boundedFetch(
          endpoint,
          { method: request.method, headers: request.headers, body, signal: request.signal },
          {
            fetchImpl: this.fetchImpl,
            signal,
            timeoutMs: this.settings.requestTimeoutMs,
            maxBytes: this.settings.maxResponseBytes,
          },
        );
      },
    });
    try {
      await client.connect(transport, { signal, timeout: this.settings.requestTimeoutMs });
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      if (signal.aborted) throw abortFailure(signal);
      if (error instanceof AskFailure) throw error;
      throw new AskFailure("ASK_MCP_UNAVAILABLE");
    }
  }

  async withConnection<T>(
    work: (connection: McpConnection) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const opened = await this.open(signal);
    try {
      return await work(opened.connection);
    } finally {
      await opened.close();
    }
  }

  async open(
    signal?: AbortSignal,
  ): Promise<{ connection: McpConnection; close: () => Promise<void> }> {
    if (!this.settings.enabled) throw new AskFailure("ASK_DISABLED", 404);
    if (this.settings.problem) throw new AskFailure("ASK_UNAVAILABLE");
    const activeSignal = AbortSignal.any([
      AbortSignal.timeout(this.settings.runTimeoutMs),
      ...(signal ? [signal] : []),
    ]);
    const client = await this.connect(activeSignal);
    return {
      connection: new McpConnection(client, this.settings, activeSignal),
      close: () => client.close().catch(() => undefined),
    };
  }
}

interface Pooled {
  key: string;
  openedAt: number;
  client: Promise<Client>;
  controller: AbortController;
  users: number;
  retired: boolean;
  discovery: SharedDiscovery;
}

/**
 * One MCP client per replica, shared by its runs for up to `ttlMs` (five
 * minutes). The MCP server is stateless and authenticates every request, so
 * a shared client holds no session. Each run gets its own view of it, bound to
 * that run's signal. The client and its discovery belong to one MCP URL,
 * credential and customer: a run with any of the three changed gets a new
 * client. Any failed call retires the client, and so do the TTL and `close()`.
 * A retired client closes once its last run lets go of it. So a source added
 * to or removed from this credential's grant reaches Ask within five minutes,
 * and the MCP server refuses a removed source's reads at once.
 */
export class McpPool {
  private current: Pooled | null = null;
  private closed = false;
  constructor(
    private readonly settings: AskSettings,
    private readonly fetchImpl?: typeof fetch,
    private readonly ttlMs = 300_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private static key(settings: AskSettings): string {
    return createHash("sha256")
      .update([settings.mcpUrl, settings.mcpToken, settings.customerId].join("\n"))
      .digest("hex");
  }

  private retire(entry: Pooled): void {
    entry.retired = true;
    if (this.current === entry) this.current = null;
    if (entry.users === 0) this.shut(entry);
  }

  private shut(entry: Pooled): void {
    entry.controller.abort(new AskFailure("ASK_INTERRUPTED"));
    void entry.client.then((client) => client.close()).catch(() => undefined);
  }

  async open(
    signal?: AbortSignal,
    settings: AskSettings = this.settings,
  ): Promise<{ connection: McpConnection; close: () => Promise<void> }> {
    if (!settings.enabled) throw new AskFailure("ASK_DISABLED", 404);
    if (settings.problem || this.closed) throw new AskFailure("ASK_UNAVAILABLE");
    const key = McpPool.key(settings);
    const stale = this.current;
    if (stale && (stale.key !== key || this.now() - stale.openedAt >= this.ttlMs))
      this.retire(stale);
    if (!this.current) {
      const controller = new AbortController();
      const entry: Pooled = {
        key,
        openedAt: this.now(),
        controller,
        users: 0,
        retired: false,
        client: new McpAdapter(settings, this.fetchImpl).connect(controller.signal),
        discovery: {
          snapshot: null,
          at: 0,
          ttlMs: this.ttlMs,
          now: this.now,
          retire: () => this.retire(entry),
        },
      };
      entry.client.catch(() => this.retire(entry));
      this.current = entry;
    }
    const entry = this.current;
    entry.users++;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      entry.users--;
      if (entry.retired && entry.users === 0) this.shut(entry);
    };
    try {
      const client = await raceAbort(entry.client, signal);
      const runSignal = AbortSignal.any([
        AbortSignal.timeout(settings.runTimeoutMs),
        ...(signal ? [signal] : []),
      ]);
      return {
        connection: new McpConnection(client, settings, runSignal, entry.discovery),
        close: release,
      };
    } catch (error) {
      await release();
      throw error;
    }
  }

  /** Retires the current client; it closes once no run holds it. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.current) this.retire(this.current);
  }
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortFailure(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortFailure(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
