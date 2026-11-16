/** Applied before model context and internal records. This is bounded credential
 * redaction, not a claim that arbitrary customer log text has been classified. */
export function redactAskText(value: string, secrets: readonly string[] = []): string {
  let result = value;
  for (const secret of secrets)
    if (secret.length >= 8) result = result.replaceAll(secret, "[redacted]");
  result = result.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  result = result.replace(
    /((?:password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
    "$1[redacted]",
  );
  // Upstream URLs frequently carry a credential in their path or query. Only
  // their scheme/host is useful to the answer; never retain that hidden part.
  result = result.replace(/https?:\/\/[^\s<>"'\\]+/gi, (raw) => {
    try {
      const url = new URL(raw);
      return `${url.protocol}//${url.host}${url.pathname !== "/" || url.search || url.username || url.password ? "/[redacted]" : ""}`;
    } catch {
      return "[redacted URL]";
    }
  });
  return result;
}

export function redactAskData(value: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  if (depth > 40) return "[depth limit]";
  if (typeof value === "string") return redactAskText(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactAskData(entry, secrets, depth + 1));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /^(password|secret|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i.test(
          key,
        )
          ? "[redacted]"
          : redactAskData(entry, secrets, depth + 1),
      ]),
    );
  return value;
}
