/**
 * Render a ResolvedRequest into copy-pasteable CLI / Python / Go / JavaScript
 * snippets.
 *
 * Snippets are an ordered list of `SnippetBlock`s so transports that need a
 * multi-step flow (WebSocket: connect, then send) can render each step as its
 * own labeled, individually-copyable code block — same shape as Alchemy /
 * QuickNode use in their dashboards.
 *
 *  - CLI        → `curl` (HTTP), `wscat` (WS interactive), `grpcurl` (gRPC).
 *  - Python     → `requests` (HTTP), `websockets` (WS), `grpc` (codegen skel).
 *  - Go         → `net/http` (HTTP), `gorilla/websocket` (WS), `grpc-go` (skel).
 *  - JavaScript → `fetch` (HTTP), native `WebSocket` (WS), codegen note (gRPC).
 *
 * Self-hosted note: unlike the cloud gateway there is no API key — requests
 * go straight to the local listen port, so no auth header/placeholder is
 * injected anywhere.
 */
import type { ResolvedGrpc, ResolvedHttp, ResolvedWs, ResolvedRequest } from "./build-request";

/** Language hint for the renderer. Restricted to the small set the
 *  drawer actually emits so callers can `switch` exhaustively. */
export type SnippetLanguage =
  | "bash"
  | "python"
  | "go"
  | "javascript"
  | "json";

export interface SnippetBlock {
  /** Optional heading shown above the code block. Single-step snippets omit. */
  label?: string;
  code: string;
  /** Language tag for IDE-style syntax highlighting. */
  language: SnippetLanguage;
}

export interface Snippets {
  cli: SnippetBlock[];
  python: SnippetBlock[];
  go: SnippetBlock[];
  javascript: SnippetBlock[];
}

const INDENT = "  ";

function jsonPretty(body: unknown | null): string {
  if (body === null || body === undefined) return "";
  return JSON.stringify(body, null, 2);
}

function jsonInline(body: unknown | null): string {
  if (body === null || body === undefined) return "";
  return JSON.stringify(body);
}

// ──────────────── HTTP ────────────────

function httpCli(req: ResolvedHttp, extra: Record<string, string> = {}): SnippetBlock[] {
  const extraCurl = Object.entries(extra).map(([k, v]) => `  -H "${k}: ${v}" \\`);
  if (req.httpMethod === "GET") {
    if (extraCurl.length === 0) return [{ language: "bash", code: `curl -s "${req.url}"` }];
    return [{ language: "bash", code: [`curl -s "${req.url}" \\`, ...extraCurl.map((l, i) => (i === extraCurl.length - 1 ? l.replace(/ \\$/, "") : l))].join("\n") }];
  }
  return [
    {
      language: "bash",
      code: [
        `curl -s -X POST "${req.url}" \\`,
        `  -H "Content-Type: ${req.contentType ?? "application/json"}" \\`,
        ...extraCurl,
        `  -d '${jsonInline(req.body)}'`,
      ].join("\n"),
    },
  ];
}

function httpPython(req: ResolvedHttp, extra: Record<string, string> = {}): SnippetBlock[] {
  const install: SnippetBlock = {
    label: "Installation",
    language: "bash",
    code: "pip install requests",
  };
  const hdrEntries = [
    `"Content-Type": "${req.contentType ?? "application/json"}"`,
    ...Object.entries(extra).map(([k, v]) => `"${k}": "${v}"`),
  ];
  const extraKw = Object.keys(extra).length
    ? `${INDENT}headers={${Object.entries(extra).map(([k, v]) => `"${k}": "${v}"`).join(", ")}},`
    : null;
  if (req.httpMethod === "GET") {
    return [
      install,
      {
        label: "Script",
        language: "python",
        code: [
          `import requests`,
          ``,
          extraKw ? `r = requests.get(` : `r = requests.get("${req.url}")`,
          ...(extraKw ? [`${INDENT}"${req.url}",`, extraKw, `)`] : []),
          `print(r.json())`,
        ].join("\n"),
      },
    ];
  }
  return [
    install,
    {
      label: "Script",
      language: "python",
      code: [
        `import requests`,
        ``,
        `payload = ${jsonPretty(req.body)}`,
        `r = requests.post(`,
        `${INDENT}"${req.url}",`,
        `${INDENT}json=payload,`,
        `${INDENT}headers={${hdrEntries.join(", ")}},`,
        `)`,
        `print(r.json())`,
      ].join("\n"),
    },
  ];
}

function httpGo(req: ResolvedHttp, extra: Record<string, string> = {}): SnippetBlock[] {
  // Go HTTP is stdlib (net/http), no install required.
  const hasExtra = Object.keys(extra).length > 0;
  if (req.httpMethod === "POST" && hasExtra) {
    // http.Post can't set custom headers — use NewRequest + client.Do.
    const setHeaders = [
      `${INDENT}req.Header.Set("Content-Type", "${req.contentType ?? "application/json"}")`,
      ...Object.entries(extra).map(([k, v]) => `${INDENT}req.Header.Set("${k}", "${v}")`),
    ];
    return [
      {
        language: "go",
        code: [
          `package main`,
          ``,
          `import (`,
          `${INDENT}"bytes"`,
          `${INDENT}"fmt"`,
          `${INDENT}"io"`,
          `${INDENT}"net/http"`,
          `)`,
          ``,
          `func main() {`,
          `${INDENT}body := []byte(\`${jsonInline(req.body)}\`)`,
          `${INDENT}req, _ := http.NewRequest("POST", "${req.url}", bytes.NewReader(body))`,
          ...setHeaders,
          `${INDENT}resp, err := http.DefaultClient.Do(req)`,
          `${INDENT}if err != nil { panic(err) }`,
          `${INDENT}defer resp.Body.Close()`,
          `${INDENT}out, _ := io.ReadAll(resp.Body)`,
          `${INDENT}fmt.Println(string(out))`,
          `}`,
        ].join("\n"),
      },
    ];
  }
  if (req.httpMethod === "GET") {
    return [
      {
        language: "go",
        code: [
          `package main`,
          ``,
          `import (`,
          `${INDENT}"fmt"`,
          `${INDENT}"io"`,
          `${INDENT}"net/http"`,
          `)`,
          ``,
          `func main() {`,
          `${INDENT}resp, err := http.Get("${req.url}")`,
          `${INDENT}if err != nil { panic(err) }`,
          `${INDENT}defer resp.Body.Close()`,
          `${INDENT}body, _ := io.ReadAll(resp.Body)`,
          `${INDENT}fmt.Println(string(body))`,
          `}`,
        ].join("\n"),
      },
    ];
  }
  return [
    {
      language: "go",
      code: [
        `package main`,
        ``,
        `import (`,
        `${INDENT}"bytes"`,
        `${INDENT}"fmt"`,
        `${INDENT}"io"`,
        `${INDENT}"net/http"`,
        `)`,
        ``,
        `func main() {`,
        `${INDENT}body := []byte(\`${jsonInline(req.body)}\`)`,
        `${INDENT}resp, err := http.Post(`,
        `${INDENT}${INDENT}"${req.url}",`,
        `${INDENT}${INDENT}"${req.contentType ?? "application/json"}",`,
        `${INDENT}${INDENT}bytes.NewReader(body),`,
        `${INDENT})`,
        `${INDENT}if err != nil { panic(err) }`,
        `${INDENT}defer resp.Body.Close()`,
        `${INDENT}out, _ := io.ReadAll(resp.Body)`,
        `${INDENT}fmt.Println(string(out))`,
        `}`,
      ].join("\n"),
    },
  ];
}

function httpJs(req: ResolvedHttp, extra: Record<string, string> = {}): SnippetBlock[] {
  const hdrs = [
    `"Content-Type": "${req.contentType ?? "application/json"}"`,
    ...Object.entries(extra).map(([k, v]) => `"${k}": "${v}"`),
  ].join(", ");
  if (req.httpMethod === "GET") {
    const getInit = Object.keys(extra).length
      ? `, { headers: { ${Object.entries(extra).map(([k, v]) => `"${k}": "${v}"`).join(", ")} } }`
      : "";
    return [
      {
        language: "javascript",
        code: [
          `const res = await fetch("${req.url}"${getInit});`,
          `const data = await res.json();`,
          `console.log(data);`,
        ].join("\n"),
      },
    ];
  }
  return [
    {
      language: "javascript",
      code: [
        `const res = await fetch("${req.url}", {`,
        `${INDENT}method: "POST",`,
        `${INDENT}headers: { ${hdrs} },`,
        `${INDENT}body: JSON.stringify(${jsonPretty(req.body)
          .split("\n")
          .map((line, i) => (i === 0 ? line : INDENT + line))
          .join("\n")}),`,
        `});`,
        `const data = await res.json();`,
        `console.log(data);`,
      ].join("\n"),
    },
  ];
}

// ──────────────── WebSocket ────────────────

function wsCli(req: ResolvedWs): SnippetBlock[] {
  // Mirror Alchemy's docs: connect with `wscat -c …` first, then send the JSON
  // message at the interactive `>` prompt as a second step.
  return [
    { label: "Open connection", language: "bash", code: `wscat -c "${req.url}"` },
    { label: "Send message at the > prompt", language: "json", code: jsonInline(req.body) },
  ];
}

function wsPython(req: ResolvedWs): SnippetBlock[] {
  return [
    { label: "Installation", language: "bash", code: "pip install websockets" },
    {
      label: "Script",
      language: "python",
      code: [
        `import asyncio, json`,
        `from websockets.asyncio.client import connect`,
        ``,
        `async def main():`,
        `${INDENT}async with connect("${req.url}") as ws:`,
        `${INDENT}${INDENT}await ws.send(json.dumps(${jsonPretty(req.body)}))`,
        `${INDENT}${INDENT}print(json.loads(await ws.recv()))`,
        ``,
        `asyncio.run(main())`,
      ].join("\n"),
    },
  ];
}

function wsGo(req: ResolvedWs): SnippetBlock[] {
  return [
    {
      label: "Installation",
      language: "bash",
      code: "go get github.com/gorilla/websocket",
    },
    {
      label: "Script",
      language: "go",
      code: [
        `package main`,
        ``,
        `import (`,
        `${INDENT}"fmt"`,
        `${INDENT}"github.com/gorilla/websocket"`,
        `)`,
        ``,
        `func main() {`,
        `${INDENT}c, _, err := websocket.DefaultDialer.Dial("${req.url}", nil)`,
        `${INDENT}if err != nil { panic(err) }`,
        `${INDENT}defer c.Close()`,
        `${INDENT}if err := c.WriteMessage(websocket.TextMessage, []byte(\`${jsonInline(req.body)}\`)); err != nil {`,
        `${INDENT}${INDENT}panic(err)`,
        `${INDENT}}`,
        `${INDENT}_, msg, err := c.ReadMessage()`,
        `${INDENT}if err != nil { panic(err) }`,
        `${INDENT}fmt.Println(string(msg))`,
        `}`,
      ].join("\n"),
    },
  ];
}

function wsJs(req: ResolvedWs): SnippetBlock[] {
  return [
    {
      language: "javascript",
      code: [
        `const ws = new WebSocket("${req.url}");`,
        `ws.addEventListener("open", () => {`,
        `${INDENT}ws.send(JSON.stringify(${jsonPretty(req.body)
          .split("\n")
          .map((line, i) => (i === 0 ? line : INDENT + line))
          .join("\n")}));`,
        `});`,
        `ws.addEventListener("message", (e) => {`,
        `${INDENT}console.log(JSON.parse(e.data));`,
        `${INDENT}ws.close();`,
        `});`,
      ].join("\n"),
    },
  ];
}

// ──────────────── gRPC / gRPC-Web ────────────────

function grpcDialAddress(req: ResolvedGrpc): string {
  if (req.transport === "grpc") return req.url;
  return req.url.replace(/^https?:\/\//, "");
}

function grpcCli(req: ResolvedGrpc): SnippetBlock[] {
  return [
    {
      language: "bash",
      code: [
        `grpcurl \\`,
        `  -d '${jsonInline(req.body)}' \\`,
        `  ${grpcDialAddress(req)} \\`,
        `  ${req.fqMethod}`,
      ].join("\n"),
    },
  ];
}

function grpcPython(req: ResolvedGrpc): SnippetBlock[] {
  const stubName = req.service.split(".").pop() ?? "Service";
  const stubMod = stubName.toLowerCase();
  return [
    {
      label: "Installation",
      language: "bash",
      code: "pip install grpcio grpcio-tools",
    },
    {
      label: "Generate stubs",
      language: "bash",
      code: [
        `# Replace your-service.proto with the .proto file that defines`,
        `# ${req.service}.`,
        `python -m grpc_tools.protoc \\`,
        `  -I . \\`,
        `  --python_out=. \\`,
        `  --grpc_python_out=. \\`,
        `  your-service.proto`,
      ].join("\n"),
    },
    {
      label: "Script",
      language: "python",
      code: [
        `import grpc`,
        `from ${stubMod}_pb2 import ${req.methodName}Request`,
        `from ${stubMod}_pb2_grpc import ${stubName}Stub`,
        ``,
        `channel = grpc.secure_channel(`,
        `    "${grpcDialAddress(req)}", grpc.ssl_channel_credentials()`,
        `)`,
        `stub = ${stubName}Stub(channel)`,
        `request = ${req.methodName}Request(**${jsonPretty(req.body)})`,
        `response = stub.${req.methodName}(request)`,
        `print(response)`,
      ].join("\n"),
    },
  ];
}

function grpcGo(req: ResolvedGrpc): SnippetBlock[] {
  const stubName = req.service.split(".").pop() ?? "Service";
  const stubMod = stubName.toLowerCase();
  return [
    {
      label: "Installation",
      language: "bash",
      code: [
        `go get google.golang.org/grpc`,
        `go install google.golang.org/protobuf/cmd/protoc-gen-go@latest`,
        `go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest`,
      ].join("\n"),
    },
    {
      label: "Generate stubs",
      language: "bash",
      code: [
        `# Replace your-service.proto with the .proto file that defines`,
        `# ${req.service}.`,
        `protoc \\`,
        `  --go_out=. \\`,
        `  --go-grpc_out=. \\`,
        `  your-service.proto`,
      ].join("\n"),
    },
    {
      label: "Script",
      language: "go",
      code: [
        `package main`,
        ``,
        `import (`,
        `${INDENT}"context"`,
        `${INDENT}"fmt"`,
        `${INDENT}"google.golang.org/grpc"`,
        `${INDENT}"google.golang.org/grpc/credentials"`,
        `${INDENT}pb "./gen/${stubMod}"`,
        `)`,
        ``,
        `func main() {`,
        `${INDENT}creds := credentials.NewClientTLSFromCert(nil, "")`,
        `${INDENT}conn, err := grpc.NewClient(`,
        `${INDENT}${INDENT}"${grpcDialAddress(req)}",`,
        `${INDENT}${INDENT}grpc.WithTransportCredentials(creds),`,
        `${INDENT})`,
        `${INDENT}if err != nil { panic(err) }`,
        `${INDENT}defer conn.Close()`,
        ``,
        `${INDENT}client := pb.New${stubName}Client(conn)`,
        `${INDENT}resp, err := client.${req.methodName}(`,
        `${INDENT}${INDENT}context.Background(),`,
        `${INDENT}${INDENT}&pb.${req.methodName}Request{},`,
        `${INDENT})`,
        `${INDENT}if err != nil { panic(err) }`,
        `${INDENT}fmt.Println(resp)`,
        `}`,
      ].join("\n"),
    },
  ];
}

function grpcJs(req: ResolvedGrpc): SnippetBlock[] {
  const stubName = req.service.split(".").pop() ?? "Service";
  const stubMod = stubName.toLowerCase();
  const methodCamel =
    req.methodName.charAt(0).toLowerCase() + req.methodName.slice(1);
  return [
    {
      label: "Installation",
      language: "bash",
      code: "npm install grpc-web google-protobuf",
    },
    {
      label: "Generate stubs",
      language: "bash",
      code: [
        `# Requires protoc with the grpc-web plugin.`,
        `# https://github.com/grpc/grpc-web#code-generator-plugin`,
        `protoc \\`,
        `  -I . \\`,
        `  --js_out=import_style=commonjs,binary:./gen \\`,
        `  --grpc-web_out=import_style=typescript,mode=grpcwebtext:./gen \\`,
        `  your-service.proto`,
      ].join("\n"),
    },
    {
      label: "Script",
      language: "javascript",
      code: [
        `import { ${stubName}Client } from "./gen/${stubMod}_grpc_web_pb";`,
        `import { ${req.methodName}Request } from "./gen/${stubMod}_pb";`,
        ``,
        `const client = new ${stubName}Client("${req.url}");`,
        `const request = new ${req.methodName}Request();`,
        `// populate request from: ${jsonInline(req.body)}`,
        ``,
        `client.${methodCamel}(request, {}, (err, resp) => {`,
        `${INDENT}if (err) { console.error(err); return; }`,
        `${INDENT}console.log(resp.toObject());`,
        `});`,
      ].join("\n"),
    },
  ];
}

// ──────────────── Dispatch ────────────────

export function snippetsFor(req: ResolvedRequest, selectUpstream?: string): Snippets {
  if (req.transport === "http") {
    // Pin header threads into HTTP snippets so a copied curl/fetch reproduces the
    // same upstream-pinned call the live Send makes.
    const extra: Record<string, string> = selectUpstream
      ? { "lava-select-provider": selectUpstream }
      : {};
    return {
      cli: httpCli(req, extra),
      python: httpPython(req, extra),
      go: httpGo(req, extra),
      javascript: httpJs(req, extra),
    };
  }
  if (req.transport === "ws") {
    return {
      cli: wsCli(req),
      python: wsPython(req),
      go: wsGo(req),
      javascript: wsJs(req),
    };
  }
  return {
    cli: grpcCli(req),
    python: grpcPython(req),
    go: grpcGo(req),
    javascript: grpcJs(req),
  };
}
