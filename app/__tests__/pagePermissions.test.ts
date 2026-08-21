// /app/__tests__/pagePermissions.test.ts
//
// Binds every dashboard page to a capability, and keeps the binding honest.
//
// Every page already required a LOGIN. What 84 of them did not require was a
// PERMISSION -- any signed-in user could open /app/inventory/consignment/payments
// or /app/inventory/products/new by typing the URL. The nav had already moved to
// permissions, so the menu hid what the guards still admitted, which is the exact
// drift requirePage's own documentation warns about.
//
// The manifest is the declaration; this is the enforcement. It fails in both
// directions: a page missing from the manifest, and a manifest entry whose page
// does not actually call the guard it claims.

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { PAGE_ACCESS, enforcedPages, pendingWidening } from "@/lib/auth/pagePermissions";
import { PERMISSION_KEYS } from "@/lib/auth/permissionCatalog";

const ROOT = join(__dirname, "..", "src", "app", "(dashboard)", "app");

function pageRoutes(dir = ROOT, prefix = "/app"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...pageRoutes(full, `${prefix}/${entry}`));
    else if (entry === "page.tsx") out.push(prefix);
  }
  return out.sort();
}

function sourceOf(route: string): string {
  const rel = route === "/app" ? "" : route.slice("/app/".length);
  return readFileSync(join(ROOT, rel, "page.tsx"), "utf8");
}

describe("the manifest describes every page", () => {
  it("finds the pages it was written for, so the scan is not silently empty", () => {
    const routes = pageRoutes();
    expect(routes.length).toBeGreaterThan(200);
    expect(routes).toContain("/app/sales/pos");
  });

  it("classifies every page that exists", () => {
    // A new page nobody classified is the silent gap this prevents.
    expect(pageRoutes().filter((r) => !(r in PAGE_ACCESS))).toEqual([]);
  });

  it("names no page that does not exist", () => {
    const routes = new Set(pageRoutes());
    expect(Object.keys(PAGE_ACCESS).filter((r) => !routes.has(r))).toEqual([]);
  });
});

describe("every entry is well formed", () => {
  it("uses only real catalog permissions", () => {
    const bad = Object.entries(PAGE_ACCESS)
      .filter(([, a]) => a.permission !== null)
      .filter(([, a]) => !(PERMISSION_KEYS as readonly string[]).includes(a.permission as string))
      .map(([r, a]) => `${r} -> ${a.permission}`);
    expect(bad).toEqual([]);
  });

  it("makes an open page say why it is open", () => {
    // "No permission" without a reason is indistinguishable from an oversight.
    for (const [route, a] of Object.entries(PAGE_ACCESS)) {
      if (a.permission !== null) continue;
      expect(typeof a.reason).toBe("string");
      expect((a.reason ?? "").length).toBeGreaterThan(25);
    }
  });
});

describe("the guards match what the manifest claims", () => {
  it("enforces the permission on every page that claims one", () => {
    // The link that makes the manifest more than documentation.
    const missing = enforcedPages()
      .filter(([route, a]) => !sourceOf(route).includes(`permission: "${a.permission}"`))
      .map(([route, a]) => `${route} should call requirePage with ${a.permission}`);
    expect(missing).toEqual([]);
  });

  it("has NOT applied the entries that would widen access", () => {
    // These await a human decision. If one gets applied without the manifest
    // being updated, access was granted quietly during a security change --
    // exactly what the widensFrom marker exists to stop.
    const applied = pendingWidening()
      .filter(([route, a]) => sourceOf(route).includes(`permission: "${a.permission}"`))
      .map(([route]) => route);
    expect(applied).toEqual([]);
  });

  it("still covers the pages that had no authorization at all", () => {
    // Regression pin for the original finding: these admitted any signed-in user.
    for (const route of [
      "/app/inventory/consignment/payments",
      "/app/inventory/products/new",
      "/app/inventory/physical-count",
    ]) {
      const entry = PAGE_ACCESS[route];
      expect(entry?.permission).toEqual(expect.any(String));
      expect(sourceOf(route)).toContain(`permission: "${entry.permission}"`);
    }
  });
});
