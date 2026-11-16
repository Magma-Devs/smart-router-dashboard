import { defineConfig } from "@playwright/test";
import base, { serverEnv } from "./playwright.config.js";
import { API_URL, DATABASE_URL, MANAGED_STACK, WEB_URL } from "./support/env.js";

const local = (url: string) => ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
if (
  process.env.CI ||
  process.env.E2E_ASK_LIVE !== "true" ||
  !MANAGED_STACK ||
  !local(API_URL) ||
  !local(WEB_URL) ||
  !local(DATABASE_URL) ||
  !/^\/ask_test_live(?:_[a-z0-9_]+)?$/.test(new URL(DATABASE_URL).pathname)
)
  throw new Error(
    "Live Ask requires explicit opt-in, owned local servers and an ask_test_live database",
  );
const required = [
  "ASK_DATA_CUSTOMER_ID",
  "ASK_DATA_MCP_URL",
  "ASK_DATA_MCP_TOKEN",
  "ASK_DATA_BEDROCK_MODEL",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ASK_DATA_TOKEN_COUNTER",
  "ASK_DATA_TOKEN_COUNTER_MODEL",
  "ASK_DATA_PRICING_JSON",
] as const;
for (const key of required) if (!process.env[key]) throw new Error(`Live Ask requires ${key}`);
for (const [key, prefix] of [
  ["E2E_ASK_LIVE_PROVIDER_META_FILE", "/private/tmp/sr-ask-live-provider-"],
  ["E2E_ASK_LIVE_RESULT_FILE", "/private/tmp/sr-ask-live-browser-"],
] as const) {
  const value = process.env[key];
  if (!value?.startsWith(prefix) || value.includes("/../"))
    throw new Error(`Live Ask requires an owned temporary ${key}`);
}
const sourceIds: unknown = JSON.parse(process.env.E2E_ASK_LIVE_SOURCE_IDS || "null");
if (
  !Array.isArray(sourceIds) ||
  !sourceIds.length ||
  sourceIds.some((id: unknown) => typeof id !== "string")
)
  throw new Error("Live Ask requires the currently verified MCP source IDs");
const servers = Array.isArray(base.webServer) ? base.webServer : [];
const apiEnv = Object.fromEntries(required.map((key) => [key, process.env[key]!]));
const noProviderEnv = Object.fromEntries(required.map((key) => [key, ""]));
export default defineConfig({
  ...base,
  testDir: "./ask-live-specs",
  outputDir: "./.playwright/ask-live-results",
  preserveOutput: "never",
  retries: 0,
  timeout: 480_000,
  reporter: [["list"]],
  use: { ...base.use, trace: "off", screenshot: "off", video: "off", actionTimeout: 30_000 },
  webServer: [
    {
      ...servers[0]!,
      command:
        "pnpm --filter @sr/api exec node --import ../../e2e/support/ask-live-observer.mjs --import tsx src/main.ts",
      env: {
        ...serverEnv,
        ...apiEnv,
        E2E_ASK_LIVE: "true",
        E2E_ASK_LIVE_PROVIDER_META_FILE: process.env.E2E_ASK_LIVE_PROVIDER_META_FILE || "",
        DEPLOYMENT_MODE: "managed",
        ASK_DATA_ENABLED: "true",
        ASK_DATA_BEDROCK_REGION: process.env.ASK_DATA_BEDROCK_REGION || "us-east-1",
        ASK_DATA_MONTHLY_LIMIT_MICRO_USD: "10000000",
        ASK_DATA_RETENTION_DAYS: "90",
        API_PORT: new URL(API_URL).port || "8119",
        AWS_REGION: "",
        AWS_DEFAULT_REGION: "",
        SES_ENDPOINT: "",
        NODE_OPTIONS: "",
      },
    },
    {
      ...servers[1]!,
      env: {
        ...servers[1]!.env,
        ...noProviderEnv,
        DEPLOYMENT_MODE: "managed",
        ASK_DATA_ENABLED: "true",
        AWS_REGION: "",
        AWS_DEFAULT_REGION: "",
        SES_ENDPOINT: "",
        NODE_OPTIONS: "",
      },
    },
  ],
});
