import { defineConfig } from "@playwright/test";
import base from "./ask.playwright.config.js";

const servers = Array.isArray(base.webServer) ? base.webServer : [];

export default defineConfig({
  ...base,
  testDir: "./ask-presentation",
  outputDir: "./.playwright/ask-presentation",
  webServer: servers.map((server, index) =>
    index === 0 ? { ...server, env: { ...server.env, ASK_TEST_PRESENTATION: "true" } } : server,
  ),
});
