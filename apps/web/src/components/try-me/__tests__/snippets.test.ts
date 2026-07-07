import { describe, expect, it } from "vitest";
import type { ResolvedRequest } from "../build-request";
import { snippetsFor, type SnippetBlock } from "../snippets";

/** Pull out the Script block (after Installation) for multi-block snippets,
 *  falling back to the only block for single-block snippets. */
function script(blocks: SnippetBlock[]): string {
  const named = blocks.find((b) => b.label === "Script");
  if (named) return named.code;
  return blocks[blocks.length - 1]?.code ?? "";
}

function installBlock(blocks: SnippetBlock[]): SnippetBlock | undefined {
  return blocks.find((b) => b.label === "Installation");
}

const POST: ResolvedRequest = {
  transport: "http",
  httpMethod: "POST",
  url: "http://localhost:3360",
  body: { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
  contentType: "application/json",
};

const GET: ResolvedRequest = {
  transport: "http",
  httpMethod: "GET",
  url: "http://localhost:3362/cosmos/base/tendermint/v1beta1/blocks/latest",
  body: null,
  contentType: null,
};

const WS: ResolvedRequest = {
  transport: "ws",
  url: "ws://localhost:3360/websocket",
  body: { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
};

const GRPC: ResolvedRequest = {
  transport: "grpc",
  url: "localhost:3363",
  service: "cosmos.base.tendermint.v1beta1.Service",
  methodName: "GetLatestBlock",
  fqMethod: "cosmos.base.tendermint.v1beta1.Service/GetLatestBlock",
  body: {},
};

const GRPC_WEB: ResolvedRequest = {
  transport: "grpc-web",
  url: "https://localhost:3363",
  service: "cosmos.base.tendermint.v1beta1.Service",
  methodName: "GetLatestBlock",
  fqMethod: "cosmos.base.tendermint.v1beta1.Service/GetLatestBlock",
  body: { height: "340801" },
};

describe("snippetsFor — HTTP POST (JSON-RPC)", () => {
  it("CLI: single curl block with -X POST + Content-Type + inline JSON body", () => {
    const out = snippetsFor(POST);
    expect(out.cli).toHaveLength(1);
    const cli = out.cli[0]?.code ?? "";
    expect(cli).toContain('-X POST "http://localhost:3360"');
    expect(cli).toContain('"Content-Type: application/json"');
    expect(cli).toContain(
      `'${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] })}'`,
    );
  });

  it("Python: install block + requests.post script", () => {
    const blocks = snippetsFor(POST).python;
    expect(installBlock(blocks)?.code).toBe("pip install requests");
    const py = script(blocks);
    expect(py).toContain("import requests");
    expect(py).toContain("r = requests.post(");
    expect(py).toContain(`"${POST.url}",`);
    expect(py).toContain("json=payload");
    expect(py).toContain(`"method": "eth_blockNumber"`);
  });

  it("Go: net/http POST with bytes.NewReader body", () => {
    const go = snippetsFor(POST).go[0]?.code ?? "";
    expect(go).toContain("package main");
    expect(go).toContain('"net/http"');
    expect(go).toContain("http.Post(");
    expect(go).toContain(`"${POST.url}"`);
    expect(go).toContain("bytes.NewReader(body)");
    expect(go).toContain(`"method":"eth_blockNumber"`);
  });

  it("JavaScript: fetch with method/headers/body", () => {
    const js = snippetsFor(POST).javascript[0]?.code ?? "";
    expect(js).toContain(`fetch("${POST.url}"`);
    expect(js).toContain(`method: "POST"`);
    expect(js).toContain(`"Content-Type": "application/json"`);
    expect(js).toContain(`"method": "eth_blockNumber"`);
    expect(js).toContain("await res.json()");
  });

  it("never injects an auth header — self-hosted endpoints have no API key", () => {
    const out = snippetsFor(POST);
    for (const blocks of [out.cli, out.python, out.go, out.javascript]) {
      for (const block of blocks) {
        expect(block.code).not.toMatch(/authorization|api[-_]?key|bearer/i);
      }
    }
  });
});

describe("snippetsFor — HTTP GET (REST)", () => {
  it("CLI: bare curl with no -X / no body", () => {
    const cli = snippetsFor(GET).cli[0]?.code ?? "";
    expect(cli).toBe(`curl -s "${GET.url}"`);
    expect(cli).not.toContain("-X");
  });

  it("Python: install block + requests.get script", () => {
    const blocks = snippetsFor(GET).python;
    expect(installBlock(blocks)?.code).toBe("pip install requests");
    const py = script(blocks);
    expect(py).toContain(`requests.get("${GET.url}")`);
    expect(py).not.toContain("requests.post");
  });

  it("Go: net/http Get", () => {
    const go = snippetsFor(GET).go[0]?.code ?? "";
    expect(go).toContain(`http.Get("${GET.url}")`);
    expect(go).not.toContain("http.Post");
  });

  it("JavaScript: fetch with no options", () => {
    const js = snippetsFor(GET).javascript[0]?.code ?? "";
    expect(js).toContain(`fetch("${GET.url}")`);
    expect(js).not.toContain(`method: "POST"`);
  });
});

describe("snippetsFor — WebSocket", () => {
  it("CLI: two labeled blocks — connect, then send (Alchemy-style)", () => {
    const cli = snippetsFor(WS).cli;
    expect(cli).toHaveLength(2);
    expect(cli[0]?.label).toMatch(/open|connect/i);
    expect(cli[0]?.code).toContain(`wscat -c "${WS.url}"`);
    expect(cli[0]?.code).not.toContain("-x");
    expect(cli[1]?.label).toMatch(/send|prompt/i);
    expect(cli[1]?.code).toBe(JSON.stringify(WS.body));
  });

  it("Python: install block + websockets script", () => {
    const blocks = snippetsFor(WS).python;
    expect(installBlock(blocks)?.code).toBe("pip install websockets");
    const py = script(blocks);
    expect(py).toContain("from websockets.asyncio.client import connect");
    expect(py).toContain(`connect("${WS.url}")`);
    expect(py).toContain("await ws.send(json.dumps(");
    expect(py).toContain("await ws.recv()");
  });

  it("Go: install block + gorilla/websocket script", () => {
    const blocks = snippetsFor(WS).go;
    expect(installBlock(blocks)?.code).toBe(
      "go get github.com/gorilla/websocket",
    );
    const go = script(blocks);
    expect(go).toContain('"github.com/gorilla/websocket"');
    expect(go).toContain(`websocket.DefaultDialer.Dial("${WS.url}"`);
    expect(go).toContain("c.WriteMessage(websocket.TextMessage");
    expect(go).toContain("c.ReadMessage()");
  });

  it("JavaScript: native WebSocket with open/message handlers", () => {
    const js = snippetsFor(WS).javascript[0]?.code ?? "";
    expect(js).toContain(`new WebSocket("${WS.url}")`);
    expect(js).toContain(`ws.send(JSON.stringify(`);
    expect(js).toContain(`"method": "eth_blockNumber"`);
    expect(js).toContain(`ws.addEventListener("message"`);
    expect(js).toContain("ws.close()");
  });
});

describe("snippetsFor — gRPC", () => {
  it("CLI: grpcurl with -d, dial address, and fqMethod", () => {
    const cli = snippetsFor(GRPC).cli[0]?.code ?? "";
    expect(cli).toContain("grpcurl");
    expect(cli).toContain(`-d '${JSON.stringify({})}'`);
    expect(cli).toContain("localhost:3363");
    expect(cli).toContain(
      "cosmos.base.tendermint.v1beta1.Service/GetLatestBlock",
    );
  });

  it("Python: install + codegen + runnable script", () => {
    const blocks = snippetsFor(GRPC).python;
    expect(blocks).toHaveLength(3);
    expect(installBlock(blocks)?.code).toBe("pip install grpcio grpcio-tools");
    const codegen = blocks.find((b) => b.label === "Generate stubs");
    expect(codegen?.code).toContain("grpc_tools.protoc");
    expect(codegen?.code).toContain("--grpc_python_out=.");
    const py = script(blocks);
    expect(py).toContain("import grpc");
    expect(py).toContain("grpc.secure_channel(");
    expect(py).toContain("ServiceStub");
    expect(py).toContain("GetLatestBlockRequest");
    expect(py).toContain("stub.GetLatestBlock(request)");
    // Script should be runnable (no leading `# ` on the code body).
    expect(py.split("\n").every((l) => !l.startsWith("# "))).toBe(true);
  });

  it("Go: install + codegen + runnable script", () => {
    const blocks = snippetsFor(GRPC).go;
    expect(blocks).toHaveLength(3);
    const install = installBlock(blocks)?.code ?? "";
    expect(install).toContain("go get google.golang.org/grpc");
    expect(install).toContain("protoc-gen-go");
    expect(install).toContain("protoc-gen-go-grpc");
    const codegen = blocks.find((b) => b.label === "Generate stubs");
    expect(codegen?.code).toContain("protoc");
    expect(codegen?.code).toContain("--go-grpc_out=.");
    const go = script(blocks);
    expect(go).toContain("grpc.NewClient");
    expect(go).toContain("pb.NewServiceClient");
    expect(go).toContain("client.GetLatestBlock(");
    // Script should be runnable (no commented-out body).
    expect(go.split("\n").every((l) => !l.trim().startsWith("// "))).toBe(true);
  });

  it("JavaScript: install + codegen + runnable script", () => {
    const blocks = snippetsFor(GRPC).javascript;
    expect(blocks).toHaveLength(3);
    expect(installBlock(blocks)?.code).toBe(
      "npm install grpc-web google-protobuf",
    );
    const codegen = blocks.find((b) => b.label === "Generate stubs");
    expect(codegen?.code).toContain("--grpc-web_out=");
    const js = script(blocks);
    expect(js).toContain("ServiceClient");
    expect(js).toContain("GetLatestBlockRequest");
    expect(js).toContain("client.getLatestBlock(");
  });

  it("gRPC-Web: dial address strips the HTTPS scheme for grpcurl", () => {
    const cli = snippetsFor(GRPC_WEB).cli[0]?.code ?? "";
    expect(cli).toContain("localhost:3363");
    expect(cli).not.toContain("https://");
  });
});
