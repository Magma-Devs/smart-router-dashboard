import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESv2Client } from "@aws-sdk/client-sesv2";

/**
 * Mail with a certificate instead of an access key.
 *
 * A managed deployment on the fleet sends through SES as an IAM Roles Anywhere
 * identity: the chart renders an AWS config file whose profile sets
 * `credential_process` to `aws_signing_helper credential-process …` (the
 * helper ships in the api image), and `services/email.ts` builds its client
 * with no explicit credentials, so the SDK's default chain has to find that
 * profile on its own. This pins that it does, with the same client class and
 * nothing else: a config file naming a process that prints the
 * process-credentials JSON is enough, with no key anywhere in the environment.
 */

const ENV = [
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_EC2_METADATA_DISABLED",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
];
const saved: Record<string, string | undefined> = {};
let dir: string;

beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  for (const k of ENV) delete process.env[k];
  dir = await mkdtemp(join(tmpdir(), "sr-credential-process-"));
});

afterEach(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(dir, { recursive: true, force: true });
});

describe("the SES client's credential chain", () => {
  it("resolves credentials from a profile's credential_process alone", async () => {
    // Stands in for aws_signing_helper: prints what it prints, from a shell
    // script so no interpreter path has to survive the ini file.
    const expiration = new Date(Date.now() + 3_600_000).toISOString();
    const helper = join(dir, "helper.sh");
    await writeFile(
      helper,
      `#!/bin/sh\nprintf '%s' '${JSON.stringify({
        Version: 1,
        AccessKeyId: "ASIAPROCESS00000TEST",
        SecretAccessKey: "secret-from-the-process",
        SessionToken: "session-from-the-process",
        Expiration: expiration,
      })}'\n`,
    );
    await chmod(helper, 0o755);
    const config = join(dir, "config");
    await writeFile(config, `[default]\nregion = us-east-1\ncredential_process = ${helper}\n`);

    process.env.AWS_CONFIG_FILE = config;
    // A credentials file that does not exist, so the profile has only the config file to come from.
    process.env.AWS_SHARED_CREDENTIALS_FILE = join(dir, "no-such-credentials");
    process.env.AWS_PROFILE = "default";
    // Never reach for the instance metadata service from a test.
    process.env.AWS_EC2_METADATA_DISABLED = "true";

    const client = new SESv2Client({ region: "us-east-1" });
    try {
      const credentials = await client.config.credentials();
      expect(credentials.accessKeyId).toBe("ASIAPROCESS00000TEST");
      expect(credentials.secretAccessKey).toBe("secret-from-the-process");
      expect(credentials.sessionToken).toBe("session-from-the-process");
      expect(credentials.expiration?.toISOString()).toBe(expiration);
    } finally {
      client.destroy();
    }
  });
});
