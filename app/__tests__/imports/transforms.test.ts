// /app/__tests__/imports/transforms.test.ts
//
// Pure tests for the fixed transform set (lib/imports/transforms.ts): one
// success case and one edge case per transform, plus the small registry
// helpers.

import { applyTransform, isImportTransformKey, TRANSFORM_KEYS } from "@/lib/imports/transforms";

describe("TRIM", () => {
  test("strips leading/trailing whitespace", () => {
    expect(applyTransform("TRIM", "  Card Connect  ")).toEqual({ value: "Card Connect" });
  });
});

describe("UPPERCASE", () => {
  test("uppercases and trims", () => {
    expect(applyTransform("UPPERCASE", "  card connect ")).toEqual({ value: "CARD CONNECT" });
  });
});

describe("LOWERCASE", () => {
  test("lowercases and trims", () => {
    expect(applyTransform("LOWERCASE", "  CARD@Example.com ")).toEqual({
      value: "card@example.com",
    });
  });
});

describe("NUMBER", () => {
  test("parses a plain numeric string", () => {
    expect(applyTransform("NUMBER", "42")).toEqual({ value: 42 });
  });

  test("parses a negative decimal", () => {
    expect(applyTransform("NUMBER", "-3.5")).toEqual({ value: -3.5 });
  });

  test("reports an error for non-numeric input", () => {
    const result = applyTransform("NUMBER", "not a number");
    expect(result.value).toBeUndefined();
    expect(result.error).toMatch(/not a valid number/);
  });
});

describe("DATE", () => {
  test("parses a common date string to an ISO string", () => {
    const result = applyTransform("DATE", "2026-05-20");
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(new Date("2026-05-20").toISOString());
  });

  test("reports an error for an unparseable date", () => {
    const result = applyTransform("DATE", "not a date");
    expect(result.value).toBeUndefined();
    expect(result.error).toMatch(/not a valid date/);
  });
});

describe("CURRENCY", () => {
  test("strips a dollar sign and thousands separators", () => {
    expect(applyTransform("CURRENCY", "$1,234.56")).toEqual({ value: 1234.56 });
  });

  test("treats a parenthesized amount as negative", () => {
    expect(applyTransform("CURRENCY", "(50.00)")).toEqual({ value: -50 });
  });

  test("reports an error for non-currency input", () => {
    const result = applyTransform("CURRENCY", "n/a");
    expect(result.value).toBeUndefined();
    expect(result.error).toMatch(/not a valid currency amount/);
  });
});

describe("registry helpers", () => {
  test("TRANSFORM_KEYS lists exactly the six documented transforms", () => {
    expect([...TRANSFORM_KEYS].sort()).toEqual(
      ["TRIM", "UPPERCASE", "LOWERCASE", "NUMBER", "DATE", "CURRENCY"].sort(),
    );
  });

  test("isImportTransformKey distinguishes known from unknown keys", () => {
    expect(isImportTransformKey("TRIM")).toBe(true);
    expect(isImportTransformKey("REVERSE")).toBe(false);
  });
});
