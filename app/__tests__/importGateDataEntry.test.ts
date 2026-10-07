// /app/__tests__/importGateDataEntry.test.ts
//
// USE-06: the price-book importer is DATA_ENTRY's job -- the role "loads the
// paperwork: vendor invoices, price lists, catalog files" -- and the
// /api/pricing/* routes it posts to already require catalog.pricing. But the
// PAGE gated on admin.settings, which no built-in role below ADMIN holds, so
// the one role defined to load price lists could not open the page that loads
// them. These pin both import routes to a permission DATA_ENTRY actually has.

import { PAGE_ACCESS } from "@/lib/auth/pagePermissions";
import { permissionsForBuiltInRole } from "@/lib/auth/permissionCatalog";

const IMPORT_PAGES = ["/app/admin/pricing/import", "/app/admin/pricing/import/wesley-hall"];

describe("the price-book importer is reachable by DATA_ENTRY", () => {
  const dataEntry = permissionsForBuiltInRole("DATA_ENTRY");

  it("DATA_ENTRY holds catalog.pricing but not admin.settings", () => {
    expect(dataEntry).toContain("catalog.pricing");
    expect(dataEntry).not.toContain("admin.settings");
  });

  it.each(IMPORT_PAGES)("gates %s on a permission DATA_ENTRY has", (route) => {
    const entry = PAGE_ACCESS[route as keyof typeof PAGE_ACCESS] as { permission?: string };
    expect(entry?.permission).toBeDefined();
    // Fails against the old admin.settings gate: DATA_ENTRY would not hold it.
    expect(dataEntry).toContain(entry.permission);
  });
});
