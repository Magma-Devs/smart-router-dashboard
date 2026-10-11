import http from "node:http";
let calls = 0;
http
  .createServer(async (req, res) => {
    if (req.url === "/stats") {
      res.end(JSON.stringify({ calls }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    calls++;
    try {
      const response = await fetch("https://ethereum-rpc.publicnode.com", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(12000),
      });
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(await response.text());
    } catch {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Upstream request failed" }));
    }
  })
  .listen(8545, "0.0.0.0");
