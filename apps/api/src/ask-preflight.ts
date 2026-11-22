import { readAskSettings } from "./config.js";
import { BedrockAdapter } from "./services/ask/bedrock.js";
import { AskFailure } from "./services/ask/errors.js";
import { McpAdapter } from "./services/ask/mcp.js";
import { assertCurrentPricing, readAskBillingSettings } from "./services/ask/pricing.js";

/** Read-only readiness check while the deployed flag stays off. No inference,
 * source-data read, database write or automatic credential/model fallback. */
let stage: "configuration" | "pricing" | "mcp" | "counter" = "configuration";
try {
  if (
    process.env.ASK_DATA_PREFLIGHT !== "true" ||
    (process.env.AUTH_MODE !== "enabled" && process.env.ASK_DATA_GUEST !== "true") ||
    process.env.DEPLOYMENT_MODE !== "managed"
  )
    throw new AskFailure("ASK_UNAVAILABLE");
  const settings = readAskSettings({ ...process.env, ASK_DATA_ENABLED: "true" });
  if (settings.problem) throw new AskFailure("ASK_UNAVAILABLE");
  stage = "pricing";
  const billing = readAskBillingSettings(settings);
  if (!billing) throw new AskFailure("ASK_UNAVAILABLE");
  assertCurrentPricing(billing.pricing);
  stage = "mcp";
  const signal = AbortSignal.timeout(settings.requestTimeoutMs);
  const snapshot = await new McpAdapter(settings).withConnection(
    (connection) => connection.discover(),
    signal,
  );
  if (!snapshot.operations.length) throw new AskFailure("ASK_MCP_UNAVAILABLE");
  stage = "counter";
  const count = await new BedrockAdapter(settings).countTokens(
    {
      system: "Read-only configuration readiness probe. No inference is requested.",
      messages: [{ role: "user", content: [{ text: "Count this synthetic tool-enabled input." }] }],
      tools: [
        {
          name: "read_customer_data",
          description: "Authorized read only",
          inputSchema: { type: "object", properties: { operationId: { type: "string" } } },
        },
      ],
      forceTool: true,
    },
    billing.counter,
    AbortSignal.timeout(settings.requestTimeoutMs),
  );
  if (count < 1) throw new AskFailure("ASK_BEDROCK_UNAVAILABLE");
  const version = process.env.APP_VERSION ?? "";
  const commit = process.env.GIT_COMMIT ?? "";
  process.stdout.write(
    JSON.stringify({
      ok: true,
      timestamp: new Date().toISOString(),
      build: {
        version:
          version.length <= 160 && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/.test(version)
            ? version
            : null,
        commit: /^[a-f0-9]{40}$/i.test(commit) ? commit : null,
      },
      customerId: settings.customerId,
      model: settings.bedrockModel,
      region: settings.bedrockRegion,
      pricingVersion: billing.pricing.version,
      pricingValidUntil: billing.pricing.validUntil,
      monthlyLimitMicroUsd: billing.monthlyLimitMicroUsd.toString(),
      retentionDays: settings.retentionDays,
      sourceCount: snapshot.sources.length,
      operations: [...new Set(snapshot.operations.map((op) => op.operationId))],
      counter: billing.counter,
      countedTokens: count,
      limits: [
        "No source data read or paid inference",
        "No API, browser, internal staff or pilot acceptance",
      ],
    }) + "\n",
  );
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      ok: false,
      timestamp: new Date().toISOString(),
      stage,
      code: error instanceof AskFailure ? error.code : "PREFLIGHT_FAILED",
    }) + "\n",
  );
  process.exitCode = 1;
}
