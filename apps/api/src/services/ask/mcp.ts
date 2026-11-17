import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import type { AskSettings } from "../../config.js";
import { AskFailure, abortFailure } from "./errors.js";
import { boundedFetch } from "./http.js";
import { hasBoundedAskQuery } from "./query-bounds.js";

const identifier = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const query = z.string().min(1).max(16_000).refine(hasBoundedAskQuery);
const timestamp = z.number().finite().nonnegative();
const windowShape = { start: timestamp, end: timestamp };
const rangeValid = (p: { start: number; end: number }) =>
  p.end >= p.start && p.end - p.start <= 86_400;
const range = z.object(windowShape).strict().refine(rangeValid);
const label = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,199}$/);
const limit = z.number().int().min(1).max(1000).optional();

/** Local audited policy. Remote annotations/catalog claims cannot add operations. */
const readPolicy: Record<string, { kinds: string[]; parameters: z.ZodType }> = {
  "metrics.query": {
    kinds: ["mimir", "prometheus"],
    parameters: z.object({ query, time: timestamp.optional() }).strict(),
  },
  "metrics.query_range": {
    kinds: ["mimir", "prometheus"],
    parameters: z
      .object({ query, ...windowShape, step: z.number().min(1).max(86_400) })
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
      .object({ match: z.array(query).min(1).max(10), ...windowShape })
      .strict()
      .refine(rangeValid),
  },
  "metrics.metadata": {
    kinds: ["mimir", "prometheus"],
    parameters: z.object({ metric: label.optional(), limit }).strict(),
  },
  "logs.query": {
    kinds: ["loki"],
    parameters: z.object({ query, time: timestamp.optional(), limit }).strict(),
  },
  "logs.query_range": {
    kinds: ["loki"],
    parameters: z
      .object({
        query,
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
      .object({ match: z.array(query).min(1).max(10), ...windowShape })
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
};

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
}
export interface McpReadResult {
  sourceId: string;
  operationId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
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

export class McpConnection {
  private snapshotValue: McpSnapshot | null = null;
  constructor(
    private readonly client: Client,
    private readonly settings: AskSettings,
    private readonly signal?: AbortSignal,
  ) {}

  private async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    try {
      return unwrap(
        await this.client.callTool(
          { name, arguments: args },
          { signal: this.signal, timeout: this.settings.requestTimeoutMs },
        ),
      );
    } catch (error) {
      if (this.signal?.aborted) throw abortFailure(this.signal);
      if (error instanceof AskFailure) throw error;
      throw new AskFailure("ASK_MCP_UNAVAILABLE");
    }
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
      throw new AskFailure("ASK_IDENTITY_MISMATCH");
    }
    return identity.data.subject;
  }

  async discover(): Promise<McpSnapshot> {
    const subject = await this.verifyIdentity();
    const sources = z
      .array(sourceSchema)
      .max(40)
      .safeParse(await this.call("list_sources"));
    const catalog = catalogSchema.safeParse(await this.call("search_operations"));
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
      throw new AskFailure("ASK_IDENTITY_MISMATCH");
    }
    const tools = await this.client.listTools(
      {},
      { signal: this.signal, timeout: this.settings.requestTimeoutMs },
    );
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
          const policy = readPolicy[id];
          const remote = catalog.data.sources
            .find((entry) => entry.sourceId === s.id)
            ?.operations.find((op) => op.id === id);
          return (
            policy?.kinds.includes(s.kind) && remote?.method === "GET" && remote.readOnly === true
          );
        }),
      })),
    };
    if (!snapshot.tools.includes("execute_operation")) throw new AskFailure("ASK_MCP_UNAVAILABLE");
    this.snapshotValue = snapshot;
    return structuredClone(snapshot);
  }

  async read(
    sourceId: string,
    operationId: string,
    parameters: Record<string, unknown>,
  ): Promise<McpReadResult> {
    const snapshot = this.snapshotValue ?? (await this.discover());
    const source = snapshot.sources.find((s) => s.id === sourceId);
    const policy = readPolicy[operationId];
    const parsed = policy?.parameters.safeParse(parameters);
    if (!source || !source.operationIds.includes(operationId) || !parsed?.success)
      throw new AskFailure("ASK_TOOL_DENIED", 403);
    // Do not accept a changed/revoked grant merely because discovery once worked.
    await this.verifyIdentity();
    const result = z
      .object({
        tenantId: identifier,
        sourceId: identifier,
        operationId: z.string(),
        ok: z.boolean(),
        data: z.unknown().optional(),
        error: z.string().max(128).optional(),
      })
      .passthrough()
      .safeParse(
        await this.call("execute_operation", { sourceId, operationId, parameters: parsed.data }),
      );
    if (!result.success) throw new AskFailure("ASK_MCP_UNAVAILABLE");
    if (
      result.data.tenantId !== this.settings.customerId ||
      result.data.sourceId !== sourceId ||
      result.data.operationId !== operationId
    )
      throw new AskFailure("ASK_IDENTITY_MISMATCH");
    return {
      sourceId,
      operationId,
      ok: result.data.ok,
      data: result.data.data,
      error: result.data.error,
    };
  }
}

/** Each invocation gets a fresh immutable customer connection. No fleet fallback. */
export class McpAdapter {
  constructor(
    private readonly settings: AskSettings,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async withConnection<T>(
    work: (connection: McpConnection) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.settings.enabled) throw new AskFailure("ASK_DISABLED", 404);
    if (this.settings.problem) throw new AskFailure("ASK_UNAVAILABLE");
    const activeSignal = AbortSignal.any([
      AbortSignal.timeout(this.settings.runTimeoutMs),
      ...(signal ? [signal] : []),
    ]);
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
            signal: activeSignal,
            timeoutMs: this.settings.requestTimeoutMs,
            maxBytes: this.settings.maxResponseBytes,
          },
        );
      },
    });
    try {
      await client.connect(transport, {
        signal: activeSignal,
        timeout: this.settings.requestTimeoutMs,
      });
      return await work(new McpConnection(client, this.settings, activeSignal));
    } catch (error) {
      if (activeSignal.aborted) throw abortFailure(activeSignal);
      if (error instanceof AskFailure) throw error;
      throw new AskFailure("ASK_MCP_UNAVAILABLE");
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}
