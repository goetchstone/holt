// /app/__tests__/api500Bodies.test.ts
//
// A 500 says what failed, never why. The why -- a Prisma error's model,
// column and constraint names, a stack -- goes to logError, where the
// operator can read it, not into the response, where anyone who can reach
// the route can. QUA-04 found 37 sites in 32 route files putting
// getErrorMessage(err) into a 500 body, two of them public
// (services/public, bookings/availability); four logged nothing at all, so
// the response was the only record.
//
// 4xx bodies stay informative: they describe the caller's mistake. This
// guard is only for 500s.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const API = join(__dirname, "..", "src", "pages", "api");
const LEAKS = /getErrorMessage\(|\.message\b|\bstack\b/;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The argument of every `.status(500).json(...)`, parentheses balanced. */
function fiveHundredBodies(source: string): { line: number; body: string }[] {
  const out: { line: number; body: string }[] = [];
  const opener = /status\(500\)\s*\.json\(/g;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(source))) {
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < source.length && depth > 0) {
      if (source[j] === "(") depth++;
      else if (source[j] === ")") depth--;
      j++;
    }
    out.push({
      line: source.slice(0, m.index).split("\n").length,
      body: source.slice(m.index + m[0].length, j - 1),
    });
  }
  return out;
}

describe("API 500 responses carry no error internals", () => {
  it("finds the 500 bodies it guards (the scan is not vacuous)", () => {
    const count = routeFiles(API).reduce(
      (n, file) => n + fiveHundredBodies(readFileSync(file, "utf8")).length,
      0,
    );
    expect(count).toBeGreaterThan(100);
  });

  it("no .status(500).json(...) body includes getErrorMessage, .message or a stack", () => {
    const leaks = routeFiles(API).flatMap((file) =>
      fiveHundredBodies(readFileSync(file, "utf8"))
        .filter(({ body }) => LEAKS.test(body))
        .map(({ line, body }) => `${relative(API, file)}:${line}  ${body.replace(/\s+/g, " ")}`),
    );
    expect(leaks).toEqual([]);
  });
});
