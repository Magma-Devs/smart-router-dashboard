import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { configRoutes } from "../routes/config.js";
import { ConfigurationService } from "../services/configuration.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("GET /api/config/routers", () => {
  it("returns safe diagnostics and recovers with native YAML at a non-Helm path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sr-config-http-"));
    dirs.push(dir);
    const file = join(dir, "router.yml");
    const app = Fastify();
    app.decorate("routerConfig", new ConfigurationService("/nonexistent-dir", file));
    await app.register(configRoutes);
    try {
      const missing = await app.inject({ method: "GET", url: "/api/config/routers" });
      expect(missing.statusCode).toBe(200);
      expect(missing.json()).toEqual({ routers: [], configuration: { status: "missing" } });
      writeFileSync(file, "direct-rpc: [https://rpc.example.com/private-secret");
      const invalid = await app.inject({ method: "GET", url: "/api/config/routers" });
      expect(invalid.json()).toEqual({ routers: [], configuration: { status: "invalid" } });
      expect(invalid.body).not.toContain("private-secret");
      writeFileSync(
        file,
        `direct-rpc:
  - name: customer-node
    chain-id: ETH1
    api-interface: jsonrpc
    node-urls:
      - url: https://user:password@rpc.example.com/private-secret?key=hidden
        auth-config:
          auth-headers: { Authorization: secret-header }
`,
      );
      const loaded = await app.inject({ method: "GET", url: "/api/config/routers" });
      expect(loaded.json().configuration).toEqual({ status: "loaded", format: "sr-config" });
      expect(loaded.json().routers[0].nodes[0].name).toBe("customer-node");
      expect(loaded.json().routers[0].nodes[0].endpoints[0].urlHost).toBe(
        "https://rpc.example.com",
      );
      for (const secret of ["password", "private-secret", "hidden", "secret-header", file])
        expect(loaded.body).not.toContain(secret);
      rmSync(file);
      const removed = await app.inject({ method: "GET", url: "/api/config/routers" });
      expect(removed.json()).toEqual({ routers: [], configuration: { status: "missing" } });
    } finally {
      await app.close();
    }
  });
});
