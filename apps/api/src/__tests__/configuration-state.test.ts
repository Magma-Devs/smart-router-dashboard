import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigurationService } from "../services/configuration.js";
import { configRoutes } from "../routes/config.js";

const dirs: string[] = [];
function fixture(yaml?: string) {
  const dir = mkdtempSync(join(tmpdir(), "srdash-config-state-"));
  dirs.push(dir);
  const file = join(dir, "router.yml");
  if (yaml !== undefined) writeFileSync(file, yaml);
  return { file, service: new ConfigurationService(undefined, file) };
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const native = (name: string) => `
endpoints:
  - chain-id: ETH1
    api-interface: jsonrpc
    listen-address: "0.0.0.0:3360"
direct-rpc:
  - name: ${name}
    chain-id: ETH1
    api-interface: jsonrpc
    node-urls:
      - url: "https://example.com/private-api-key?secret=hidden"
`;

describe("configuration availability", () => {
  it.each([
    [undefined, "missing"],
    ["direct-rpc: [", "invalid"],
    ["something: unrelated", "unsupported"],
    ["routers: not-an-array", "invalid"],
    ["routers: [null]", "invalid"],
    ["routers: []", "empty"],
    ["direct-rpc: []", "empty"],
    [native("publicnode"), "ready"],
  ] as const)("distinguishes %s as %s", (yaml, status) => {
    const { service } = fixture(yaml);
    expect(service.getConfiguration().configuration?.status).toBe(status);
  });

  it("reports a directory in place of a file as invalid", () => {
    const { file, service } = fixture();
    mkdirSync(file);
    expect(service.getConfiguration().configuration?.status).toBe("invalid");
  });

  it("distinguishes denied read access and recovers without recreating the service", () => {
    const { file, service } = fixture(native("publicnode"));
    chmodSync(file, 0);
    try {
      expect(service.getConfiguration()).toEqual({
        routers: [],
        configuration: { status: "unreadable", format: null },
      });
    } finally {
      chmodSync(file, 0o600);
    }
    expect(service.getConfiguration().configuration?.status).toBe("ready");
  });

  it("reads replacements, removals and repairs on the next request", () => {
    const { file, service } = fixture(native("before"));
    expect(service.getRouters()[0]?.nodes[0]?.name).toBe("before");
    const next = `${file}.next`;
    writeFileSync(next, native("after"));
    renameSync(next, file);
    expect(service.getRouters()[0]?.nodes[0]?.name).toBe("after");
    rmSync(file);
    expect(service.getConfiguration().configuration?.status).toBe("missing");
    writeFileSync(file, native("repaired"));
    expect(service.getRouters()[0]?.nodes[0]?.name).toBe("repaired");
  });

  it("retains the existing Helm directory contract", () => {
    const { file } = fixture();
    const dir = join(file, "..", "helm");
    mkdirSync(join(dir, "core"), { recursive: true });
    writeFileSync(join(dir, "core", "values.yml"), "routers: []");
    expect(new ConfigurationService(dir).getConfiguration()).toEqual({
      routers: [],
      configuration: { status: "empty", format: "helm" },
    });
  });

  it("never returns source lines or parser errors containing credentials", () => {
    const { service } = fixture('direct-rpc: ["super-secret-token"');
    expect(JSON.stringify(service.getConfiguration())).not.toContain("super-secret-token");
    const ready = fixture(native("publicnode")).service.getConfiguration();
    expect(JSON.stringify(ready)).not.toMatch(/private-api-key|secret=hidden/);
  });

  it("returns configuration state alongside the backwards-compatible routers field", async () => {
    const { file, service } = fixture(native("publicnode"));
    const app = Fastify();
    app.decorate("routerConfig", service);
    await app.register(configRoutes);
    try {
      const ready = await app.inject("/api/config/routers");
      expect(ready.statusCode).toBe(200);
      expect(ready.json().routers[0].nodes[0].name).toBe("publicnode");
      expect(ready.json().configuration).toEqual({ status: "ready", format: "sr-config" });
      rmSync(file);
      const missing = await app.inject("/api/config/routers");
      expect(missing.json()).toEqual({
        routers: [],
        configuration: { status: "missing", format: null },
      });
    } finally {
      await app.close();
    }
  });
});
