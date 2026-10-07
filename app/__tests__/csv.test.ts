// /app/__tests__/csv.test.ts

import { serializeCsvValue, rowsToCsv } from "@/lib/csv";

describe("serializeCsvValue", () => {
  test("null and undefined become empty strings", () => {
    expect(serializeCsvValue(null)).toBe("");
    expect(serializeCsvValue(undefined)).toBe("");
  });

  test("dates serialize to ISO 8601", () => {
    expect(serializeCsvValue(new Date("2026-05-30T12:00:00.000Z"))).toBe(
      "2026-05-30T12:00:00.000Z",
    );
  });

  test("arrays serialize to JSON", () => {
    expect(serializeCsvValue(["a", "b"])).toBe('["a","b"]');
  });

  test("plain objects serialize to JSON", () => {
    expect(serializeCsvValue({ navy: "#003" })).toBe('{"navy":"#003"}');
  });

  test("class instances (Decimal-like) use their toString value, not JSON", () => {
    // Real Prisma.Decimal is a class instance, so its prototype is not
    // Object.prototype and it routes to String(v). A plain object literal
    // would instead serialize to JSON (see the themeJson case below), so the
    // mock MUST be a class instance to exercise the real Decimal path.
    class DecimalLike {
      constructor(private readonly v: string) {}
      toString(): string {
        return this.v;
      }
    }
    expect(serializeCsvValue(new DecimalLike("123.45"))).toBe("123.45");
  });

  test("numbers and booleans stringify", () => {
    expect(serializeCsvValue(0)).toBe("0");
    expect(serializeCsvValue(42)).toBe("42");
    expect(serializeCsvValue(false)).toBe("false");
  });
});

describe("rowsToCsv", () => {
  test("empty input yields empty string", () => {
    expect(rowsToCsv([])).toBe("");
  });

  test("header row is the union of keys in first-seen order", () => {
    const csv = rowsToCsv([
      { id: 1, name: "A" },
      { id: 2, name: "B", extra: "x" },
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("id,name,extra");
    expect(lines[1]).toBe("1,A,");
    expect(lines[2]).toBe("2,B,x");
  });

  test("uses CRLF line endings", () => {
    const csv = rowsToCsv([{ a: 1 }, { a: 2 }]);
    expect(csv).toBe("a\r\n1\r\n2");
  });

  test("quotes fields containing comma, quote, or newline and doubles quotes", () => {
    const csv = rowsToCsv([
      { note: "hello, world" },
      { note: 'she said "hi"' },
      { note: "line1\nline2" },
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("note");
    expect(lines[1]).toBe('"hello, world"');
    expect(lines[2]).toBe('"she said ""hi"""');
    expect(lines[3]).toBe('"line1\nline2"');
  });

  test("plain values are not quoted", () => {
    const csv = rowsToCsv([{ a: "simple", b: "value" }]);
    expect(csv).toBe("a,b\r\nsimple,value");
  });

  test("null cells render empty", () => {
    const csv = rowsToCsv([{ a: null, b: "x" }]);
    expect(csv).toBe("a,b\r\n,x");
  });
});
