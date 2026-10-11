import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const fixture = new URL("./proxy.mjs", import.meta.url).href;
const privateDiagnostic = "PRIVATE_STACK_TRACE_AND_PROVIDER_DIAGNOSTIC";

async function withProxy(fetchImplementation, check) {
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    `globalThis.fetch = ${fetchImplementation}; await import(${JSON.stringify(fixture)});`,
  ]);
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = once(child, "exit");
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      assert.equal(child.exitCode, null, stderr);
      try {
        await fetch("http://127.0.0.1:8545/stats");
        ready = true;
        break;
      } catch {
        await delay(50);
      }
    }
    assert.ok(ready, "Proxy did not start");
    await check();
  } finally {
    child.kill();
    await exited;
  }
}

test("failed upstream returns a fixed 502 without private diagnostics", async () => {
  await withProxy(
    `async () => { throw new Error(${JSON.stringify(privateDiagnostic)}); }`,
    async () => {
      const response = await fetch("http://127.0.0.1:8545", {
        method: "POST",
        body: '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}',
      });
      assert.equal(response.status, 502);
      assert.equal(response.headers.get("content-type"), "application/json");
      const body = await response.text();
      assert.equal(body, '{"error":"Upstream request failed"}');
      assert.ok(!body.includes(privateDiagnostic));
    },
  );
});

test("successful upstream responses and request counts are preserved", async () => {
  await withProxy(
    `async (_url, options) => new Response(options.body, { status: 200 })`,
    async () => {
      const body = '{"jsonrpc":"2.0","id":1,"result":"0x123abc"}';
      const response = await fetch("http://127.0.0.1:8545", {
        method: "POST",
        body,
      });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), body);
      const stats = await fetch("http://127.0.0.1:8545/stats");
      assert.deepEqual(await stats.json(), { calls: 1 });
    },
  );
});
