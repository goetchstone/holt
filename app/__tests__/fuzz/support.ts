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

// ── Mutated vendor documents (the lib/pricing parsers) ───────────────────────
//
// A parser starts from a short seed document in its own format; these ops
// delete, duplicate and insert lines and swap digit runs for hostile numerals.
// 308 digits is the longest run that still reads as a finite number (a double
// tops out near 1.8e308), and it overflows once doubled or summed.

/** A hostile replacement for one digit run. */
export const hostileNumeral = fc.oneof(
  fc.nat(99_999).map(String),
  fc.constantFrom(
    "9".repeat(400),
    "9".repeat(308),
    "0",
    "00",
    "Infinity",
    "-Infinity",
    "1e999",
    "NaN",
    "-1",
    "0.00",
  ),
);

/** A hostile replacement for a whole money amount ("1,260.00"). */
export const hostileAmount = fc.oneof(
  fc.nat(99_999_999).map((c) => (c / 100).toFixed(2)),
  fc.constantFrom(
    `${"9".repeat(400)}.00`,
    `${"9".repeat(308)}.00`,
    "Infinity",
    "-Infinity",
    "1e999",
    "NaN",
    "0.00",
    "-1.00",
    "9,99",
  ),
);

export type Op =
  | { kind: "delete"; at: number }
  | { kind: "duplicate"; at: number }
  | { kind: "insert"; at: number; text: string }
  | { kind: "numerals"; at: number; nums: string[] }
  | { kind: "amounts"; at: number; amount: string };

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("delete" as const), at: fc.nat() }),
  fc.record({ kind: fc.constant("duplicate" as const), at: fc.nat() }),
  fc.record({ kind: fc.constant("insert" as const), at: fc.nat(), text: nastyString(4) }),
  fc.record({
    kind: fc.constant("numerals" as const),
    at: fc.nat(),
    nums: fc.array(hostileNumeral, { minLength: 1, maxLength: 4 }),
  }),
  fc.record({ kind: fc.constant("amounts" as const), at: fc.nat(), amount: hostileAmount }),
);

/**
 * Rewrites the `at`-th line (wrapping) that `pattern` matches, if there is one.
 * The numeral and amount ops aim only at lines that hold something to replace:
 * aimed at any line, most of them changed nothing, and a parser's overflow went
 * unfound in some runs and found in others.
 */
function rewriteLineWith(
  lines: string[],
  pattern: RegExp,
  at: number,
  rewrite: (line: string) => string,
): void {
  const targets = lines.flatMap((line, i) => (pattern.test(line) ? [i] : []));
  if (targets.length === 0) return;
  const t = targets[at % targets.length];
  lines[t] = rewrite(lines[t]);
}

/** `seed` with `ops` applied, one line at a time, joined with "\n". */
export function mutate(seed: readonly string[], ops: readonly Op[]): string {
  const lines = [...seed];
  for (const o of ops) {
    const i = lines.length === 0 ? 0 : o.at % lines.length;
    if (o.kind === "delete") lines.splice(i, 1);
    else if (o.kind === "duplicate") lines.splice(i, 0, ...lines.slice(i, i + 1));
    else if (o.kind === "insert") lines.splice(i, 0, o.text);
    else if (o.kind === "numerals") {
      // The first N digit runs, in order, become hostile numerals.
      let n = 0;
      const swap = (m: string) => (n < o.nums.length ? o.nums[n++] : m);
      rewriteLineWith(lines, /\d/, o.at, (line) => line.replace(/\d+/g, swap));
    } else {
      // Every money amount on the line (price AND total) becomes the same value.
      rewriteLineWith(lines, /\d\.\d/, o.at, (line) => line.replace(/\d[\d,]*\.\d+/g, o.amount));
    }
  }
  return lines.join("\n");
}

/** Documents made from `seed` by up to six ops. */
export const documentFor = (seed: readonly string[]): fc.Arbitrary<string> =>
  fc.array(op, { maxLength: 6 }).map((ops) => mutate(seed, ops));

/** Every number anywhere in a parse result, with its path. */
export function numbersIn(
  value: unknown,
  path = "result",
  out: Array<[string, number]> = [],
): Array<[string, number]> {
  if (typeof value === "number") out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => numbersIn(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) numbersIn(v, `${path}.${k}`, out);
  }
  return out;
}

export interface MoneyLine {
  qty: number;
  unitPrice: number;
  lineTotal: number;
}

/** The items of a parse result that carry a quantity, a unit price and a line total. */
export function moneyLines(result: unknown): MoneyLine[] {
  const items = (result as { items?: unknown[] }).items ?? [];
  return items.filter(
    (i): i is MoneyLine =>
      typeof (i as MoneyLine).qty === "number" &&
      typeof (i as MoneyLine).unitPrice === "number" &&
      typeof (i as MoneyLine).lineTotal === "number",
  );
}
