// /app/__tests__/configurableImportEntities.test.ts
//
// Vendor is the fourth entity on the configurable import path, and the first
// added since the seam was proved with departments. The point of adding it is
// that a deployment importing a supplier list no longer needs a code change --
// they map their columns and run it.
//
// Two doors reach the same writer: pages/api/vendors/import.ts takes a JSON
// array, the runner takes a mapped CSV. This pins the parts that make that
// true, and the two judgement calls in the writer that a naive upsert gets
// wrong.

import { IMPORT_ENTITIES, getImportEntity } from "@/lib/genericImport";
import { getImportRunner, listRegisteredRunnerKeys } from "@/lib/imports/runnerRegistry";

describe("vendor is on the configurable import path", () => {
  it("is a declared entity with a required name", () => {
    const entity = getImportEntity("vendor");
    expect(entity).toBeDefined();
    const required = (entity?.fields ?? []).filter((f) => f.required).map((f) => f.key);
    expect(required).toEqual(["name"]);
  });

  it("has a registered runner, so a definition can name it", () => {
    expect(listRegisteredRunnerKeys()).toContain("vendor");
    expect(getImportRunner("vendor")).toBeDefined();
  });

  it("covers the fields the JSON route already accepted", () => {
    // The route used to write these directly. If the entity does not carry them,
    // routing it through the shared writer would silently drop data.
    const keys = (getImportEntity("vendor")?.fields ?? []).map((f) => f.key);
    for (const k of ["name", "phone", "email", "address", "city", "state", "zip"]) {
      expect(keys).toContain(k);
    }
  });

  it("offers aliases for the column names a real file uses", () => {
    // The operator maps columns by hand, but a supplier export saying
    // "Supplier" rather than "Vendor Name" should land without being told.
    const name = getImportEntity("vendor")?.fields.find((f) => f.key === "name");
    expect(name?.aliases).toEqual(expect.arrayContaining(["supplier", "manufacturer"]));
  });
});

describe("category and type carry their parent, and differ on a missing one", () => {
  it("requires a department on a category and a category on a type", () => {
    const required = (key: string) =>
      (getImportEntity(key)?.fields ?? [])
        .filter((f) => f.required)
        .map((f) => f.key)
        .sort();
    expect(required("category")).toEqual(["department", "name"]);
    expect(required("type")).toEqual(["category", "name"]);
  });

  it("says a category CREATES a missing department", () => {
    // A category cannot be filed without one, and departments are a short flat
    // list where an invented name is visible rather than buried.
    const help =
      getImportEntity("category")?.fields.find((f) => f.key === "department")?.help ?? "";
    expect(help).toMatch(/created/i);
  });

  it("says a type REFUSES a missing category", () => {
    // Types are the most numerous level. A mistyped category would silently
    // create a near-duplicate and split the catalog in two, with products
    // landing in whichever half they were imported against.
    const help = getImportEntity("type")?.fields.find((f) => f.key === "category")?.help ?? "";
    expect(help).toMatch(/ERROR|error/);
  });
});

describe("every declared entity can actually be run", () => {
  it("has a runner for each entity, or the entity is unreachable", () => {
    // An entity with no runner shows up in the admin UI and then fails at run
    // time, which is worse than not offering it.
    const runners = listRegisteredRunnerKeys();
    const orphaned = IMPORT_ENTITIES.map((e) => e.key).filter((k) => !runners.includes(k));
    expect(orphaned).toEqual([]);
  });
});
