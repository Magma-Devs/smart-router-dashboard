import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for the SES v2 HTTP API, for tests that need a send to happen.
 *
 * It speaks just enough of `POST /v2/email/outbound-emails` for the real
 * `SESv2Client` to talk to it, so a test exercises the transport the api ships
 * — region, endpoint, credentials, request shape — rather than a mocked
 * `send()`. Point `SES_ENDPOINT` at `url` and set `AWS_REGION` plus static keys.
 *
 * `mode` decides the answer: `accept` returns a MessageId, `refuse` a 400 the
 * SDK turns into a thrown error, and `hold` never answers until `release()`.
 */
export interface FakeSes {
  url: string;
  /** Every message handed over, in order, as the JSON body SES received. */
  sent: SesMessage[];
  mode: "accept" | "refuse" | "hold";
  /** Answer every held request as `accept`, and accept from now on — a send
   *  still on its way when this is called is not left hanging. */
  release(): void;
  close(): Promise<void>;
}

export interface SesMessage {
  to: string[];
  subject: string;
  text: string;
  html: string | undefined;
}

interface SendEmailBody {
  Destination?: { ToAddresses?: string[] };
  Content?: {
    Simple?: {
      Subject?: { Data?: string };
      Body?: { Text?: { Data?: string }; Html?: { Data?: string } };
    };
  };
}

export async function startFakeSes(): Promise<FakeSes> {
  const held: ServerResponse[] = [];
  let seq = 0;

  const accept = (res: ServerResponse) => {
    seq += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ MessageId: `fake-${seq}` }));
  };

  const fake: FakeSes = {
    url: "",
    sent: [],
    mode: "accept",
    release() {
      fake.mode = "accept";
      for (const res of held.splice(0)) accept(res);
    },
    close: () =>
      new Promise((resolve) => {
        fake.release();
        server.close(() => resolve());
      }),
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.startsWith("/v2/email/outbound-emails")) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw) as SendEmailBody;
      const simple = body.Content?.Simple;
      fake.sent.push({
        to: body.Destination?.ToAddresses ?? [],
        subject: simple?.Subject?.Data ?? "",
        text: simple?.Body?.Text?.Data ?? "",
        html: simple?.Body?.Html?.Data,
      });

      if (fake.mode === "refuse") {
        res.writeHead(400, {
          "content-type": "application/json",
          "x-amzn-errortype": "MessageRejected",
        });
        res.end(JSON.stringify({ message: "Email address is not verified." }));
        return;
      }
      if (fake.mode === "hold") {
        held.push(res);
        return;
      }
      accept(res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

/** The env that points the api's SES client at a fake. Static keys, so the
 *  SDK never goes looking for credentials on the host. */
export function fakeSesEnv(fake: FakeSes): Record<string, string> {
  return {
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKE",
    AWS_SECRET_ACCESS_KEY: "fake-secret-key-for-tests",
    SES_ENDPOINT: fake.url,
  };
}
