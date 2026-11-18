const credentialKeys = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "password",
  "passwd",
  "pwd",
  "secret",
  "clientsecret",
  "apikey",
  "xapikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "sessiontoken",
  "xamzsecuritytoken",
  "awssecretaccesskey",
  "secretaccesskey",
  "awsaccesskeyid",
  "accesskeyid",
  "privatekey",
  "token",
]);
const isCredentialKey = (key: string) =>
  credentialKeys.has(key.replace(/[-_\s]/g, "").toLowerCase());

/** Applied before persistence, model context and internal records. This is bounded credential
 * redaction, not a claim that arbitrary customer log text has been classified. */
export function redactAskText(value: string, secrets: readonly string[] = []): string {
  let result = value;
  for (const secret of secrets)
    if (secret.length >= 8) result = result.replaceAll(secret, "[redacted]");
  result = result.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  // Header values may contain spaces, commas and semicolons (Basic/Digest and
  // cookies). Removing just their first token leaves the credential behind.
  result = result.replace(
    /\b((?:proxy[-_ ]?)?authorization|(?:set[-_ ]?)?cookie)\s*:[^\r\n]*/gi,
    "$1: [redacted]",
  );
  result = result.replace(
    /\b([A-Za-z][A-Za-z0-9_-]*)(["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;}\]]+)/g,
    (raw, key: string, separator: string, value: string) => {
      if (!isCredentialKey(key)) return raw;
      const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
      return `${key}${separator}${quote}[redacted]${quote}`;
    },
  );
  result = result.replace(
    /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )*PRIVATE KEY-----|$)/g,
    "[redacted]",
  );
  // Upstream URLs frequently carry a credential in their path or query. Only
  // their scheme/host is useful to the answer; never retain that hidden part.
  result = result.replace(
    /\b(?:https?|wss?|postgres(?:ql)?|mysql|rediss?|mongodb(?:\+srv)?):\/\/[^\s<>"'\\]+/gi,
    (raw) => {
      try {
        const url = new URL(raw);
        return `${url.protocol}//${url.host}${url.pathname !== "/" || url.search || url.hash || url.username || url.password ? "/[redacted]" : ""}`;
      } catch {
        return "[redacted URL]";
      }
    },
  );
  return result;
}

export function redactAskData(value: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  if (depth > 40) return "[depth limit]";
  if (typeof value === "string") return redactAskText(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactAskData(entry, secrets, depth + 1));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        redactAskText(key, secrets),
        isCredentialKey(key) ? "[redacted]" : redactAskData(entry, secrets, depth + 1),
      ]),
    );
  return value;
}
