/**
 * The GraphQL half of the Try-it drawer: turn the query box into the body the
 * router expects, and lay a one-line catalog query out for reading.
 *
 * The router reads a GraphQL-over-HTTP envelope — `{ query, variables?,
 * operationName? }` — and parses `query` with a real GraphQL parser
 * (smart-router `chainlib/chainproxy/rpcInterfaceMessages/graphqlMessage.go`),
 * so any layout of the same document is the same request.
 */

export type GraphQLBodyResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The query box holds a GraphQL document, sent as `{"query": <text>}` on one
 * line (`compactGraphQL`) — the box shows it laid out, the wire and the
 * snippets carry it the way JSON-RPC params are carried, compact. Text that
 * parses as a JSON object is instead a whole envelope the caller wrote out —
 * the way to send `variables` or pick an `operationName` — and goes as it
 * stands. The two cannot be confused: a GraphQL selection set names its
 * fields unquoted, so a document is never valid JSON.
 */
export function graphqlBody(text: string): GraphQLBodyResult {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, error: "Write a GraphQL query to send." };
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = undefined;
    }
    if (isPlainObject(parsed)) {
      const query = parsed["query"];
      if (typeof query !== "string" || query.trim() === "") {
        return { ok: false, error: 'A JSON body needs a "query" string.' };
      }
      return { ok: true, value: parsed };
    }
  }
  return { ok: true, value: { query: compactGraphQL(trimmed) } };
}

/**
 * Whether a response body carries GraphQL errors. A GraphQL server answers a
 * query it refused with HTTP 200 and an `errors` list, so the status alone
 * reads as success. Partial data still counts as an error: a field the caller
 * asked for came back as one.
 */
export function hasGraphQLErrors(body: unknown): boolean {
  if (!isPlainObject(body)) return false;
  const errors = body["errors"];
  return Array.isArray(errors) && errors.length > 0;
}

type Token = "{" | "}" | { word: string };

/**
 * Split a document into braces and words. Argument lists stay whole, braces
 * and strings inside them included: `availableRange(type: "Checkpoint")` is
 * one word, and so is `multiGetObjects(keys: [{ address: "0x5" }])`. Null
 * for anything the layout can't vouch for: a comment (flattening it would
 * comment out the rest of the line), a block string, or unbalanced brackets.
 */
function tokenize(query: string): Token[] | null {
  if (query.includes('"""')) return null;
  const tokens: Token[] = [];
  let word = "";
  let parens = 0;
  let inString = false;
  const flush = () => {
    if (word !== "") tokens.push({ word });
    word = "";
  };
  for (let i = 0; i < query.length; i++) {
    const ch = query[i]!;
    if (inString) {
      word += ch;
      if (ch === "\\" && i + 1 < query.length) word += query[++i];
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      word += ch;
      continue;
    }
    if (ch === "#") return null;
    if (ch === "(") parens++;
    if (ch === ")" && --parens < 0) return null;
    if (parens > 0 || ch === ")") {
      word += ch;
      continue;
    }
    if (ch === "{" || ch === "}") {
      flush();
      tokens.push(ch);
    } else if (/[\s,]/.test(ch)) {
      flush();
    } else {
      word += ch;
    }
  }
  if (inString || parens !== 0) return null;
  flush();
  return tokens;
}

/** Words that read as one phrase with the word before them: an argument
 *  list, a directive, a fragment's type condition, an alias. */
function gluesTo(prev: string | null, next: string): boolean {
  if (prev === null) return false;
  if (prev.endsWith(":") || prev === "..." || prev === "on") return true;
  return next.startsWith("(") || next.startsWith("@") || next.startsWith(":");
}

/**
 * Lay a query out one field per line, the way GraphiQL shows it:
 *
 *   { checkpoint { sequenceNumber digest } }
 *
 *   {
 *     checkpoint {
 *       sequenceNumber
 *       digest
 *     }
 *   }
 *
 * Only whitespace changes, and only outside strings and argument lists.
 * GraphQL reads every run of whitespace, and every comma, the same way, so
 * the result is the same request. Anything `tokenize` refuses comes back
 * unchanged.
 */
export function formatGraphQL(query: string): string {
  const tokens = tokenize(query);
  if (tokens === null) return query;
  const lines: string[] = [];
  let line = "";
  let depth = 0;
  let prev: string | null = null;
  const pad = () => "  ".repeat(depth);
  for (const token of tokens) {
    if (token === "{") {
      lines.push(line === "" ? `${pad()}{` : `${line} {`);
      line = "";
      depth++;
      prev = null;
    } else if (token === "}") {
      if (line !== "") lines.push(line);
      line = "";
      depth--;
      if (depth < 0) return query;
      lines.push(`${pad()}}`);
      prev = null;
    } else {
      const { word } = token;
      if (line === "") {
        line = `${pad()}${word}`;
      } else if (depth === 0 || gluesTo(prev, word)) {
        // Outside a selection set — `query Name($id: ID!)`, `mutation` —
        // words share the line the brace will close.
        line += ` ${word}`;
      } else {
        lines.push(line);
        line = `${pad()}${word}`;
      }
      prev = word;
    }
  }
  if (depth !== 0) return query;
  if (line !== "") lines.push(line);
  return lines.join("\n");
}

/**
 * The inverse of `formatGraphQL`: the same document on one line, one space
 * between tokens. Whitespace inside strings and argument lists is kept as
 * written, and anything `tokenize` refuses comes back unchanged — a comment
 * needs its line break to end.
 */
export function compactGraphQL(query: string): string {
  const tokens = tokenize(query);
  if (tokens === null) return query;
  return tokens.map((token) => (typeof token === "string" ? token : token.word)).join(" ");
}
