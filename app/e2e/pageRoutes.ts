// /app/e2e/pageRoutes.ts
//
// Every App Router page in the app, read from the file tree: a route is the
// path of a `page.tsx` under src/app with route groups like `(dashboard)`
// removed. Shared by the browser smoke suite (pages.spec.ts), which opens each
// one, and by __tests__/e2eDynamicRoutes.test.ts, which checks the manifest of
// dynamic routes against it (rule 65).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const APP_DIR = join(__dirname, "..", "src", "app");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return name === "page.tsx" ? [full] : [];
  });
}

function routeOf(file: string): string {
  const parts = relative(APP_DIR, file)
    .split(sep)
    .slice(0, -1)
    .filter((p) => !(p.startsWith("(") && p.endsWith(")")));
  return `/${parts.join("/")}`;
}

const FILES = new Map(walk(APP_DIR).map((file) => [routeOf(file), file]));

/** Every page route, e.g. `/app/sales/orders/[id]`, sorted. */
export function pageRoutes(): string[] {
  return [...FILES.keys()].sort();
}

/** The module a page requires (`requireModule("key")` in its page.tsx), if any.
 *  A page whose module is off 404s by design, so the suite skips it and says so. */
export function moduleOf(route: string): string | null {
  const file = FILES.get(route);
  if (!file) return null;
  return /requireModule\(\s*"([^"]+)"\s*\)/.exec(readFileSync(file, "utf8"))?.[1] ?? null;
}

/** A route with a `[param]` segment needs a value before it can be opened. */
export function isDynamic(route: string): boolean {
  return route.includes("[");
}
