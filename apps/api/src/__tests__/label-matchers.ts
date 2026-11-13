/**
 * The label matchers of the first `{…}` in a PromQL or LogQL expression,
 * evaluated against one series' labels as the store does: `=` and `!=`
 * exact, `=~` and `!~` a regex anchored at both ends, case-sensitive. A
 * missing label is the empty string. Values are double-quoted strings, their
 * escapes read as JSON reads them (the subset of Go's the api writes).
 */
export function selectorMatches(expr: string, labels: Record<string, string>): boolean {
  const body = /\{([^}]*)\}/.exec(expr)?.[1] ?? "";
  for (const [, name, op, quoted] of body.matchAll(/(\w+)\s*(=~|!~|!=|=)\s*("(?:[^"\\]|\\.)*")/g)) {
    const want = JSON.parse(quoted!) as string;
    const have = labels[name!] ?? "";
    const hit = op === "=" || op === "!=" ? have === want : new RegExp(`^(?:${want})$`).test(have);
    if (hit !== (op === "=" || op === "=~")) return false;
  }
  return true;
}
