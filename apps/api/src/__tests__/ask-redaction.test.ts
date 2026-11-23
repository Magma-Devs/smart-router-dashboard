import { describe, expect, it } from "vitest";
import { redactAskData, redactAskText } from "../services/ask/redact.js";

describe("Ask credential redaction across untrusted inputs", () => {
  it.each([
    "authorization",
    "Proxy-Authorization",
    "Cookie",
    "Set-Cookie",
    "password",
    "client_secret",
    "clientSecret",
    "api_key",
    "X-API-Key",
    "access_token",
    "refreshToken",
    "id_token",
    "session_token",
    "X-Amz-Security-Token",
    "aws_secret_access_key",
    "secretAccessKey",
    "private_key",
    "token",
  ])("removes credential field %s from nested tool data", (field) => {
    const secret = "synthetic-credential-value-for-redaction";
    const value = { data: [{ [field]: secret }], inputTokens: 12, status: "ok" };
    const redacted = redactAskData(value);
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(redacted).toMatchObject({ inputTokens: 12, status: "ok" });
  });

  it.each([
    "Authorization: Basic c3ludGhldGljOnByaXZhdGU=",
    'Proxy-Authorization: Digest username="synthetic-private-value", response="opaque"',
    "Cookie: session=synthetic-private-value; another=opaque",
    "Set-Cookie: session=synthetic-private-value; HttpOnly; Secure",
    '{"client_secret":"synthetic-private-value","status":"ok"}',
    "aws_secret_access_key=synthetic-private-value",
    "private_key='synthetic-private-value'",
    "-----BEGIN RSA PRIVATE KEY-----\nsynthetic-private-value\n-----END RSA PRIVATE KEY-----",
  ])("removes common credential text without requiring a known runtime value", (value) => {
    const result = redactAskText(value);
    expect(result).not.toMatch(
      /c3ludGhldGljOnByaXZhdGU=|synthetic-private-value|response="opaque"|another=opaque/,
    );
    expect(result).toContain("[redacted]");
  });

  it.each([
    "https",
    "http",
    "wss",
    "ws",
    "postgres",
    "postgresql",
    "mysql",
    "redis",
    "rediss",
    "mongodb",
    "mongodb+srv",
  ])("keeps only the public origin of a %s connection URL", (scheme) => {
    const value = `${scheme}://synthetic-user:synthetic-private-value@fixture.test/private-path?credential=opaque`;
    expect(redactAskText(value)).toBe(`${scheme}://fixture.test/[redacted]`);
  });

  it("removes known runtime secrets from object keys as well as values", () => {
    const secret = "synthetic-runtime-credential-value";
    const result = redactAskData({ [secret]: "public-value", child: { value: secret } }, [secret]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).toMatchObject({ "[redacted]": "public-value", child: { value: "[redacted]" } });
  });

  it("keeps a caller's hex customer-id in metric results and answer text", () => {
    const customer = "0123456789abcdef".repeat(4);
    const result = {
      data: {
        result: [{ metric: { customer, method: "debug_traceTransaction" }, value: [1, "42"] }],
      },
    };
    expect(redactAskData(result)).toEqual(result);
    const answer = `Customer **${customer}** sent the most debug requests.`;
    expect(redactAskText(answer)).toBe(answer);
  });

  it("preserves unrelated field types and quoted non-credential metadata", () => {
    const value = {
      inputTokens: 10,
      totalTokens: 20,
      outcome: false,
      data: null,
      title: "key metrics",
    };
    expect(redactAskData(value)).toEqual(value);
    expect(redactAskText('{"status":"ok","count":12}')).toBe('{"status":"ok","count":12}');
  });
});
