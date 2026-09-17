import { describe, expect, it } from "vitest";
import { escapeCsvField, toCsv } from "../utils/csv.js";

describe("escapeCsvField", () => {
  it("leaves ordinary values alone", () => {
    expect(escapeCsvField("Dana Levi")).toBe("Dana Levi");
    expect(escapeCsvField("dana@example.com")).toBe("dana@example.com");
  });

  it("renders null and undefined as empty, not as the words", () => {
    expect(escapeCsvField(null)).toBe("");
    expect(escapeCsvField(undefined)).toBe("");
  });

  it("quotes values containing a delimiter, quote, or newline", () => {
    expect(escapeCsvField("Levi, Dana")).toBe('"Levi, Dana"');
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvField("two\nlines")).toBe('"two\nlines"');
  });

  it("neutralises every formula lead", () => {
    // The file opens in a spreadsheet by default and display names are chosen
    // by the people in the list.
    for (const lead of ["=", "+", "-", "@"]) {
      expect(escapeCsvField(`${lead}1+1`)).toBe(`'${lead}1+1`);
    }
  });

  it("neutralises leads hidden behind whitespace some parsers skip", () => {
    expect(escapeCsvField("\t=1+1")).toBe("'\t=1+1");
    expect(escapeCsvField("\r=1+1")).toBe('"\'\r=1+1"');
  });

  it("guards first, then quotes — so a dangerous value can't slip through", () => {
    expect(escapeCsvField('=cmd|"/c calc"')).toBe(`"'=cmd|""/c calc"""`);
  });
});

describe("toCsv", () => {
  it("writes a header and rows with CRLF endings", () => {
    // Excel on Windows collapses everything into one cell without CRLF.
    expect(
      toCsv(
        ["a", "b"],
        [
          ["1", "2"],
          ["3", "4"],
        ],
      ),
    ).toBe("a,b\r\n1,2\r\n3,4");
  });

  it("has no trailing newline", () => {
    expect(toCsv(["a"], [["1"]]).endsWith("\r\n")).toBe(false);
  });

  it("escapes headers too", () => {
    expect(toCsv(["=evil"], [])).toBe("'=evil");
  });

  it("handles an empty row set", () => {
    expect(toCsv(["name", "email"], [])).toBe("name,email");
  });
});
