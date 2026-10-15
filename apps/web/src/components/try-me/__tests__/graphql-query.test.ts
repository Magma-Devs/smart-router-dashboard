import { describe, expect, it } from "vitest";
import { compactGraphQL, formatGraphQL, graphqlBody, hasGraphQLErrors } from "../graphql-query";

describe("graphqlBody", () => {
  it("wraps a query document in the GraphQL-over-HTTP envelope", () => {
    expect(graphqlBody("{ chainIdentifier }")).toEqual({
      ok: true,
      value: { query: "{ chainIdentifier }" },
    });
  });

  it("sends the query on one line, however the box lays it out", () => {
    expect(graphqlBody("\n{\n  checkpoint {\n    digest\n  }\n}\n\n")).toEqual({
      ok: true,
      value: { query: "{ checkpoint { digest } }" },
    });
  });

  it("sends a JSON envelope as it stands, so variables reach the router", () => {
    const envelope = {
      query: "query ($d: String!) { transaction(digest: $d) { digest } }",
      variables: { d: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S" },
      operationName: null,
    };
    expect(graphqlBody(JSON.stringify(envelope, null, 2))).toEqual({ ok: true, value: envelope });
  });

  it("refuses a JSON body with no query in it", () => {
    for (const text of ["{}", '{"variables":{}}', '{"query":"  "}', '{"query":1}']) {
      const out = graphqlBody(text);
      expect(out.ok, text).toBe(false);
      if (!out.ok) expect(out.error).toContain('"query"');
    }
  });

  it("refuses an empty box", () => {
    expect(graphqlBody("  \n ").ok).toBe(false);
  });

  it("treats a mutation and a JSON array as documents, never as envelopes", () => {
    // Only a JSON OBJECT is an envelope. The router's parser answers the rest.
    expect(graphqlBody("mutation { executeTransaction }")).toEqual({
      ok: true,
      value: { query: "mutation { executeTransaction }" },
    });
    expect(graphqlBody("[1]")).toEqual({ ok: true, value: { query: "[1]" } });
  });
});

describe("formatGraphQL", () => {
  it("puts one field per line, indented by selection depth", () => {
    expect(formatGraphQL("{ checkpoint { sequenceNumber digest timestamp } }")).toBe(
      ["{", "  checkpoint {", "    sequenceNumber", "    digest", "    timestamp", "  }", "}"].join("\n"),
    );
  });

  it("keeps an argument list whole, braces and strings inside it included", () => {
    expect(
      formatGraphQL('{ multiGetObjects(keys: [{ address: "0x5" }, { address: "0x6" }]) { address version } }'),
    ).toBe(
      [
        "{",
        '  multiGetObjects(keys: [{ address: "0x5" }, { address: "0x6" }]) {',
        "    address",
        "    version",
        "  }",
        "}",
      ].join("\n"),
    );
  });

  it("leaves braces and parens inside a string alone", () => {
    expect(formatGraphQL('{ type(type: "a) { b") { repr } }')).toBe(
      ["{", '  type(type: "a) { b") {', "    repr", "  }", "}"].join("\n"),
    );
  });

  it("keeps the operation line together", () => {
    expect(formatGraphQL('mutation Run($b: Base64!) { executeTransaction(transactionDataBcs: $b, signatures: []) { effects { status } } }')).toBe(
      [
        "mutation Run($b: Base64!) {",
        "  executeTransaction(transactionDataBcs: $b, signatures: []) {",
        "    effects {",
        "      status",
        "    }",
        "  }",
        "}",
      ].join("\n"),
    );
  });

  it("keeps aliases, directives and fragment conditions on their field's line", () => {
    expect(formatGraphQL("{ tip: checkpoint @include(if: true) { ... on Checkpoint { digest } } }")).toBe(
      [
        "{",
        "  tip: checkpoint @include(if: true) {",
        "    ... on Checkpoint {",
        "      digest",
        "    }",
        "  }",
        "}",
      ].join("\n"),
    );
  });

  it("reads commas as the separators GraphQL says they are", () => {
    expect(formatGraphQL("{ a, b }")).toBe(["{", "  a", "  b", "}"].join("\n"));
  });

  it("returns what it cannot lay out safely unchanged", () => {
    for (const query of [
      "{ a # a comment would swallow the rest of the line\n b }",
      '{ a(s: """block""") }',
      "{ a { b }",
      "{ a } }",
      '{ a(s: "unterminated) }',
      "{ a(b: 1 }",
    ]) {
      expect(formatGraphQL(query), query).toBe(query);
    }
  });

  it("changes nothing but whitespace", () => {
    const query = '{ serviceConfig { availableRange(type: "Checkpoint") { first { sequenceNumber } last { sequenceNumber } } } }';
    const squash = (s: string) => s.replace(/\s+/g, "");
    expect(squash(formatGraphQL(query))).toBe(squash(query));
  });
});

describe("compactGraphQL", () => {
  it("undoes formatGraphQL on the catalog's one-line queries", () => {
    for (const query of [
      "{ chainIdentifier }",
      '{ serviceConfig { availableRange(type: "Checkpoint") { first { sequenceNumber } last { sequenceNumber } } } }',
      'mutation { executeTransaction(transactionDataBcs: "<base64 transaction bytes>", signatures: ["<base64 signature>"]) { effects { status digest } } }',
      '{ multiGetObjects(keys: [{ address: "0x5" }, { address: "0x6" }]) { address version } }',
    ]) {
      expect(compactGraphQL(formatGraphQL(query)), query).toBe(query);
    }
  });

  it("keeps the whitespace inside a string as written", () => {
    expect(compactGraphQL('{\n  nameRecord(name: "two  spaces") {\n    domain\n  }\n}')).toBe(
      '{ nameRecord(name: "two  spaces") { domain } }',
    );
  });

  it("leaves a comment its line break", () => {
    const query = "{\n  chainIdentifier # the genesis digest\n}";
    expect(compactGraphQL(query)).toBe(query);
  });
});

describe("hasGraphQLErrors", () => {
  it("reads a non-empty errors list as a failure, data or no data", () => {
    const error = { message: 'Failed to parse "String": Invalid Base58', path: ["transaction"] };
    expect(hasGraphQLErrors({ data: null, errors: [error] })).toBe(true);
    expect(hasGraphQLErrors({ data: { a: 1, transaction: null }, errors: [error] })).toBe(true);
  });

  it("reads anything else as no GraphQL error", () => {
    expect(hasGraphQLErrors({ data: { chainIdentifier: "4bti" } })).toBe(false);
    expect(hasGraphQLErrors({ data: {}, errors: [] })).toBe(false);
    expect(hasGraphQLErrors({ jsonrpc: "2.0", id: 1, result: "0x1" })).toBe(false);
    expect(hasGraphQLErrors([{ errors: [1] }])).toBe(false);
    expect(hasGraphQLErrors(null)).toBe(false);
  });
});
