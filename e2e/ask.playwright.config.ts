import { defineConfig } from "@playwright/test";
import base, { serverEnv } from "./playwright.config.js";
import { API_URL, WEB_URL, MANAGED_STACK } from "./support/env.js";

const servers = Array.isArray(base.webServer) ? base.webServer : [];
const askEnv = {
  DEPLOYMENT_MODE: "managed",
  ASK_DATA_ENABLED: "true",
  ASK_DATA_CUSTOMER_ID: "e2e-customer",
  ASK_DATA_MCP_URL: "https://ask-mcp.e2e.invalid/mcp",
  ASK_DATA_MCP_TOKEN: "synthetic-mcp-key",
  ASK_DATA_BEDROCK_MODEL: "anthropic.fixture",
  AWS_BEARER_TOKEN_BEDROCK: "synthetic-provider-key",
  ASK_DATA_TOKEN_COUNTER: "runtime",
  ASK_DATA_TOKEN_COUNTER_MODEL: "anthropic.fixture",
  ASK_DATA_PRICING_JSON: JSON.stringify({
    version: "browser-fixture-only",
    model: "anthropic.fixture",
    region: "us-east-1",
    validFrom: "2026-01-01T00:00:00Z",
    validUntil: "2030-01-01T00:00:00Z",
    source: "https://aws.amazon.com/bedrock/pricing/",
    input: "1000000",
    output: "2000000",
    cacheRead: "100000",
    cacheWrite5m: "1250000",
    cacheWrite1h: "2000000",
  }),
  // No real email transport may inherit the developer's AWS configuration.
  AWS_REGION: "",
  AWS_DEFAULT_REGION: "",
  SES_ENDPOINT: "",
};
export default defineConfig({
  ...base,
  testDir: "./ask-specs",
  outputDir: "./.playwright/ask-results",
  timeout: 150_000,
  use: { ...base.use, actionTimeout: 30_000 },
  webServer: MANAGED_STACK
    ? [
        {
          ...servers[0]!,
          command:
            "pnpm --filter @sr/api exec node --import ../../e2e/support/ask-provider-fixture.mjs --import tsx src/main.ts",
          env: { ...serverEnv, ...askEnv, API_PORT: new URL(API_URL).port || "8000" },
        },
        {
          ...servers[1]!,
          command: `pnpm --filter @sr/web exec next dev --port ${new URL(WEB_URL).port || "3000"}`,
          env: { ...servers[1]!.env, ...askEnv },
        },
      ]
    : undefined,
});
