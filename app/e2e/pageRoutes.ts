// /app/e2e/pageRoutes.ts
//
// Every page in the app, read from the file tree (rule 65), so a new screen is
// opened without anyone listing it. An App Router route is the path of a
// `page.tsx` under src/app with route groups like `(dashboard)` removed. A
// Pages Router screen is a `.tsx` under src/pages outside `api/`, other than
// Next's `_app` and `_document`: today the three /auth/* sign-in screens.
// Shared by the browser smoke suite (pages.spec.ts), which opens each one, and
// by __tests__/e2eDynamicRoutes.test.ts, which checks the manifest of dynamic
// routes against it.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const APP_DIR = join(__dirname, "..", "src", "app");
const PAGES_DIR = join(__dirname, "..", "src", "pages");

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

function walkPagesRouter(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      return full === join(PAGES_DIR, "api") ? [] : walkPagesRouter(full);
    }
    return name.endsWith(".tsx") && !name.startsWith("_") ? [full] : [];
  });
}

/** Every Pages Router screen, e.g. `/auth/login`, sorted. */
export function pagesRouterRoutes(): string[] {
  return walkPagesRouter(PAGES_DIR)
    .map((file) => {
      const path = relative(PAGES_DIR, file)
        .split(sep)
        .join("/")
        .replace(/\.tsx$/, "");
      return `/${path.replace(/(^|\/)index$/, "")}`;
    })
    .sort();
}
