import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetEmailClientForTests, sendEmail } from "../services/email.js";
import { startFakeSes, type FakeSes } from "./fake-ses.js";

/**
 * Mail with an access key from the environment, and nothing else.
 *
 * A managed deployment on the fleet sends through SES with a per-tenant key
 * pair: the chart hands the backend `AWS_ACCESS_KEY_ID` and
 * `AWS_SECRET_ACCESS_KEY` from a Secret (`mail.accessKeySecret`), next to
 * `AWS_REGION`, and nothing else — no AWS config file, no credentials file, no
 * instance role. This pins that the pair alone is enough: the send reaches
 * SES, signed with that key for that region.
 */

const ENV = [
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_EC2_METADATA_DISABLED",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "SES_ENDPOINT",
  "EMAIL_FROM",
  "EMAIL_CONFIGURATION_SET",
  "EMAIL_REPLY_TO",
];
const saved: Record<string, string | undefined> = {};
let fake: FakeSes;

beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  for (const k of ENV) delete process.env[k];
  resetEmailClientForTests();
  fake = await startFakeSes();
});

afterEach(async () => {
  await fake.close();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEmailClientForTests();
});

describe("the SES client's credentials", () => {
  it("signs the send with the key pair from the environment alone", async () => {
    // Nothing for the SDK's chain to find besides the two variables: config
    // and credentials files that do not exist, and no instance metadata.
    const nowhere = join(tmpdir(), "sr-ses-credentials-none");
    process.env.AWS_CONFIG_FILE = join(nowhere, "config");
    process.env.AWS_SHARED_CREDENTIALS_FILE = join(nowhere, "credentials");
    process.env.AWS_EC2_METADATA_DISABLED = "true";

    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_ACCESS_KEY_ID = "AKIATENANTMAILKEY000";
    process.env.AWS_SECRET_ACCESS_KEY = "tenant-mail-secret-for-tests";
    process.env.SES_ENDPOINT = fake.url;

    const res = await sendEmail({ to: "someone@example.com", subject: "Hi", text: "body" });

    expect(res.status).toBe("sent");
    expect(fake.sent).toHaveLength(1);
    expect(fake.credentials).toHaveLength(1);
    const [keyId, , region, service] = (fake.credentials[0] ?? "").split("/");
    expect(keyId).toBe("AKIATENANTMAILKEY000");
    expect(region).toBe("us-east-1");
    expect(service).toBe("ses");
  });
});
