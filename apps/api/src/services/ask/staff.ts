import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import type { AskSettings } from "../../config.js";
import { AskFailure } from "./errors.js";
import { boundedFetch } from "./http.js";

/** This is a separate read-record principal. Its credential is never available
 * to the chat orchestrator, and a customer admin is never promoted to staff. */
export async function verifyAskStaff(
  settings: AskSettings,
  token: string,
  fetchImpl?: typeof fetch,
): Promise<string> {
  const endpoint = new URL(settings.mcpUrl);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(settings.customerId) ||
    !/^[^\s]{16,8192}$/.test(token)
  )
    throw new AskFailure("ASK_TOOL_DENIED", 403);
  const signal = AbortSignal.timeout(settings.requestTimeoutMs);
  const client = new Client(
    { name: "smart-router-internal-records", version: "1" },
    { capabilities: {}, versionNegotiation: { mode: "legacy" } },
  );
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${token}` }, redirect: "error" },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== endpoint.toString()) throw new AskFailure("ASK_TOOL_DENIED", 403);
      const body = request.method === "POST" ? await request.text() : undefined;
      if (body && Buffer.byteLength(body) > 8192) throw new AskFailure("ASK_TOOL_DENIED", 403);
      return boundedFetch(
        endpoint.toString(),
        { method: request.method, headers: request.headers, body, signal: request.signal },
        { fetchImpl, signal, timeoutMs: settings.requestTimeoutMs, maxBytes: 32_000 },
      );
    },
  });
  try {
    await client.connect(transport, { signal, timeout: settings.requestTimeoutMs });
    const result = await client.callTool(
      { name: "whoami", arguments: {} },
      { signal, timeout: settings.requestTimeoutMs },
    );
    if (result.isError) throw new AskFailure("ASK_TOOL_DENIED", 403);
    const structured = result.structuredContent;
    let raw: unknown =
      typeof structured === "object" && structured !== null && "result" in structured
        ? structured.result
        : undefined;
    if (raw === undefined && result.content.length === 1 && result.content[0]?.type === "text")
      raw = JSON.parse(result.content[0].text) as unknown;
    const identity = z
      .object({
        access: z.literal("staff"),
        subject: z.string().min(1).max(200),
        scopes: z.array(z.string()).max(20),
        tenantIds: z.array(z.string().max(64)).min(1).max(100),
      })
      .passthrough()
      .parse(raw);
    if (
      !identity.scopes.includes("read") ||
      identity.scopes.some((scope) => scope !== "read") ||
      !identity.tenantIds.includes(settings.customerId)
    )
      throw new AskFailure("ASK_TOOL_DENIED", 403);
    return identity.subject;
  } catch {
    throw new AskFailure("ASK_TOOL_DENIED", 403);
  } finally {
    await client.close().catch(() => undefined);
  }
}
