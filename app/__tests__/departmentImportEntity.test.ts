// /app/__tests__/departmentImportEntity.test.ts
//
// Departments are the first entity added to the configurable import path since
// the seam was built, so these guard the property that made adding it worth
// doing: ONE writer behind TWO doors.
//
// The fixed-shape REST route (pages/api/departments/import.ts, which the admin
// Import page posts to) and the configurable runner (runnerKey "department")
// must both go through runGenericImport. Before this, the REST route carried
// its own copy of the upsert — which is exactly how two import paths start
// disagreeing about what importing a department means.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IMPORT_ENTITIES, getImportEntity } from "@/lib/genericImport";
import { isRegisteredRunnerKey, listRegisteredRunnerKeys } from "@/lib/imports/runnerRegistry";

const APP = join(__dirname, "..");
const REST = readFileSync(join(APP, "src", "pages", "api", "departments", "import.ts"), "utf8");
const RUNNER = readFileSync(
  join(APP, "src", "lib", "imports", "runners", "departmentRunner.ts"),
  "utf8",
);

describe("department import", () => {
  it("is a declared entity with a required name field", () => {
    const entity = getImportEntity("department");
    expect(entity).toBeDefined();
    const name = entity!.fields.find((f) => f.key === "name");
    expect(name?.required).toBe(true);
  });

  it("has a registered runner, so a definition naming it can actually run", () => {
    // Without this, /api/admin/imports/run refuses the definition — correctly,
    // but the entity would be authorable and never importable.
    expect(isRegisteredRunnerKey("department")).toBe(true);
  });

  it("every declared entity that can be configured has a runner", () => {
    // The gap this catches: an entity added to IMPORT_ENTITIES without a
    // runner is authorable in the admin UI and refused at run time.
    const runners = new Set(listRegisteredRunnerKeys());
    const missing = IMPORT_ENTITIES.map((e) => e.key).filter((k) => !runners.has(k));
    expect(missing).toEqual([]);
  });

  it("the REST route delegates rather than carrying its own upsert", () => {
    expect(REST).toContain("runGenericImport(");
    expect(REST).not.toMatch(/prisma\.department\.(upsert|create|update)/);
  });

  it("the runner delegates too, so both doors share one writer", () => {
    expect(RUNNER).toContain("runGenericImport(");
    expect(RUNNER).not.toMatch(/prisma\./);
  });
});
