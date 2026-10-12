import { writeFile } from "node:fs/promises";
const results = [];
const target = process.env.ROUTER_TEST_URL ?? "http://127.0.0.1:3360";
const count = Number(process.argv[2] ?? 25);
for (let id = 1; id <= count; id++) {
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id }),
      signal: AbortSignal.timeout(30000),
    });
    const body = await response.json();
    results.push({
      at: new Date().toISOString(),
      status: response.status,
      provider: response.headers.get("lava-provider-address"),
      body,
    });
  } catch {
    results.push({ at: new Date().toISOString(), error: "Request did not complete" });
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
await writeFile(
  process.argv[3] ?? "/tmp/mag4226-live-traffic.json",
  JSON.stringify(results, null, 2) + "\n",
);
console.log(`Recorded ${results.length} real router responses.`);
