// /app/__tests__/allListRequestTripwire.test.ts
//
// A client that asks a list route for `?all=true` gets every row only if that
// route reads `all`. The list routes page at a default of 10, so asking a
// route without `all` returns the first 10 and nothing says so: Create
// Variant's master-product picker asked /api/products?all=true and offered 10
// products to choose from (it now searches as you type), and TaxonomyPicker and
// CategoryModal asked /api/types and /api/labels the same way before those
// routes learned `all`.
//
// Tripwire (rule 65, principle 3): every `"/api/...?...all=true"` literal in
// src/ must resolve to a Pages Router route under src/pages/api that reads
// `query.all`. A request whose route cannot be found fails too, rather than
// passing unchecked. The scan must find requests at all, so it cannot pass by
// finding nothing.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const APP_DIR = join(__dirname, "..");
const SRC = join(APP_DIR, "src");

/** A quoted API path whose query string carries all=true. */
const ALL_REQUEST = /["'`](\/api\/[^"'`?$]+)\?(?:[^"'`]*&)?all=true\b/g;
/** How a Pages Router handler reads the `all` parameter. */
const READS_ALL = /\bquery\s*\.\s*all\b|\bquery\s*\[\s*["']all["']\s*\]/;

function sourceFiles(dir: string): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out = out.concat(sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** Code only: a request described in a comment is not a request. */
function codeOf(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const t = line.trimStart();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
}

function routeFileFor(apiPath: string): string | null {
  const base = join(SRC, "pages", apiPath);
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface AllRequest {
  file: string;
  apiPath: string;
}

function allRequests(): AllRequest[] {
  const found: AllRequest[] = [];
  for (const file of sourceFiles(SRC)) {
    const code = codeOf(readFileSync(file, "utf8"));
    for (const m of code.matchAll(ALL_REQUEST)) {
      found.push({ file: relative(APP_DIR, file), apiPath: m[1] });
    }
  }
  return found;
}

describe("?all=true requests reach a route that reads all", () => {
  const requests = allRequests();

  it("finds the pickers' all=true requests (the scan is not vacuous)", () => {
    expect(requests.length).toBeGreaterThan(10);
  });

  it("every all=true request names a route that reads query.all", () => {
    const problems: string[] = [];
    for (const r of requests) {
      const route = routeFileFor(r.apiPath);
      if (!route) {
        problems.push(`${r.file}: ${r.apiPath}?all=true, but no route file was found for it`);
        continue;
      }
      if (!READS_ALL.test(readFileSync(route, "utf8"))) {
        problems.push(
          `${r.file}: ${r.apiPath}?all=true, but ${relative(APP_DIR, route)} never reads query.all, so it returns one page`,
        );
      }
    }
    expect(problems).toEqual([]);
  });
});
