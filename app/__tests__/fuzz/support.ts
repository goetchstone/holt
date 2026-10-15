// /app/__tests__/fuzz/support.ts
//
// Shared generators and checks for the property-based fuzz tests in this
// directory (docs/testing/fuzzing.md). Not a test file: the unit project only
// collects `*.test.ts`.

import fc from "fast-check";

/** Keys that walk the prototype chain when used as a property name. */
export const PROTO_KEYS = [
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
] as const;

/**
 * A fuzz dictionary: tokens that historically break parsers. Mixed into
 * generated input so a 100-run property reaches them, which uniform random
 * strings almost never do.
 */
export const NASTY_TOKENS = [
  "",
  " ",
  "\t",
  "\r\n",
  "\n",
  "\r",
  "\u0000",
  " ",
  " ",
  "﻿",
  "NaN",
  "Infinity",
  "-Infinity",
  "1e999",
  "-0",
  "0x1F",
  "9".repeat(400),
  "$",
  "(",
  ")",
  ",",
  ";",
  ":",
  "=",
  '"',
  "'",
  "\\",
  "<",
  ">",
  "&",
  "<b>",
  "</p>",
  "<script>alert(1)</script>",
  '"><img src=x onerror=alert(1)>',
  "&lt;",
  "../",
  "..\\",
  "%2e%2e%2f",
  "é",
  "😀",
  "\ud800",
  ...PROTO_KEYS,
] as const;

/** Any full-range string (every code point, incl. control and astral). */
export const anyString = (maxLength = 200): fc.Arbitrary<string> =>
  fc.string({ unit: "binary", maxLength });

/** Strings built from the nasty-token dictionary plus random fragments. */
export const nastyString = (maxParts = 12): fc.Arbitrary<string> =>
  fc
    .array(fc.oneof(fc.constantFrom(...NASTY_TOKENS), anyString(20)), { maxLength: maxParts })
    .map((parts) => parts.join(""));

/**
 * A JSON object whose keys may include `__proto__` as an OWN property -- the
 * shape `JSON.parse` hands a request handler, which an object literal cannot
 * express. Values are arbitrary JSON.
 */
export const jsonObjectWithProtoKeys = (): fc.Arbitrary<Record<string, unknown>> =>
  fc
    .array(
      fc.tuple(
        fc.oneof(fc.constantFrom(...PROTO_KEYS), anyString(10)),
        fc.oneof(
          fc.jsonValue({ maxDepth: 2 }),
          fc.constant({ polluted: "yes" }),
          fc.constant({ toString: "x" }),
        ),
      ),
      { maxLength: 8 },
    )
    .map(
      (pairs) =>
        JSON.parse(
          `{${pairs.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",")}}`,
        ) as Record<string, unknown>,
    );

const PROTOTYPES: ReadonlyArray<[string, object]> = [
  ["Object.prototype", Object.prototype],
  ["Array.prototype", Array.prototype],
  ["Function.prototype", Function.prototype],
  ["String.prototype", String.prototype],
];

// Every own key of every built-in prototype, with the value it holds, so a
// payload that REPLACES an existing method (Object.prototype.toString = ...)
// is caught as well as one that adds a key.
function prototypeShape(): Array<[string, unknown]> {
  return PROTOTYPES.flatMap(([name, proto]) =>
    Reflect.ownKeys(proto).map((key): [string, unknown] => [
      `${name}.${String(key)}`,
      Object.getOwnPropertyDescriptor(proto, key)?.value,
    ]),
  );
}

/**
 * Run `fn` and fail if it added, removed or replaced a key on a built-in
 * prototype. Returns whatever `fn` returned.
 */
export function withoutPrototypePollution<T>(fn: () => T): T {
  const before = prototypeShape();
  const result = fn();
  expect(prototypeShape()).toEqual(before);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  return result;
}

/** Wall-clock milliseconds for one synchronous call. */
export function timeMs(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}
