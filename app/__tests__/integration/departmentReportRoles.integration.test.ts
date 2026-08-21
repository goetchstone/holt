/**
 * The department reporting-role backfill must reproduce the classifiers it
 * replaced, name for name.
 *
 * crossSell.ts and designerDashboard.ts carried hardcoded department names.
 * Moving them onto Department columns is only safe if every existing deployment
 * reports the SAME numbers afterwards, so this runs the actual SQL from
 * migration 20260821120000_department_report_roles against a real database and
 * compares it to the old logic, transcribed below as the specification.
 *
 * The SQL is READ FROM THE MIGRATION FILE, not retyped here -- a rewritten
 * backfill has to keep passing this, and a test carrying its own copy of the
 * statements would pass while the migration drifted.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { prisma } from "@/lib/prisma";

const MIGRATION = join(
  __dirname,
  "..",
  "..",
  "prisma",
  "migrations",
  "20260821120000_department_report_roles",
  "migration.sql",
);

/** getCategoryForDepartment() as it stood before this change. The spec. */
function oldCategoryFor(deptName: string): string | null {
  const CATEGORY_DEPARTMENT_MAP: Record<string, string[]> = {
    Furniture: ["furniture", "outdoor furniture"],
    "Window Treatments": ["curtains", "window"],
    Rugs: ["rugs", "rug"],
    "Home Shop": [],
  };
  const EXCLUDED = ["apparel", "mens apparel", "womens apparel", "accessories"];
  const lower = deptName.toLowerCase();
  if (EXCLUDED.some((ex) => lower.includes(ex))) return null; // "__excluded__"
  for (const [category, keywords] of Object.entries(CATEGORY_DEPARTMENT_MAP)) {
    if (category === "Home Shop") continue;
    if (keywords.some((kw) => lower.includes(kw))) return category;
  }
  return "Home Shop";
}

/** TARGET_DEPTS as it stood before this change. */
const OLD_TARGETS = [
  "Rugs",
  "Curtains",
  "Outdoor Furniture",
  "Lamps",
  "Bedding",
  "Womens Apparel",
  "Mens Apparel",
  "Home Acc",
];

// Every department name the old code could meet: the real Saybrook taxonomy,
// the demo seed's names, and the cases that decide a branch.
const NAMES = [
  "Furniture",
  "Outdoor Furniture",
  "Curtains",
  "Window Treatments",
  "Rugs",
  "Area Rug",
  "Lamps",
  "Bedding",
  "Womens Apparel",
  "Mens Apparel",
  "Apparel",
  "Home Acc",
  "Accessories & Decor",
  "Living Room",
  "Bedroom",
  "Dining",
  "Outdoor",
  "Lighting",
  "Mattresses",
];

/** The UPDATE statements only -- the ALTER TABLEs already ran via db push. */
function backfillStatements(): string[] {
  const sql = readFileSync(MIGRATION, "utf8");
  const updates = sql.match(/UPDATE "Department"[\s\S]*?;/g) ?? [];
  if (updates.length < 3) {
    throw new Error(`expected 3 UPDATE statements in the migration, found ${updates.length}`);
  }
  return updates;
}

describe("department report-role backfill reproduces the old classifiers", () => {
  beforeAll(async () => {
    await prisma.department.deleteMany({ where: { name: { in: NAMES } } });
    for (const name of NAMES) {
      await prisma.department.create({ data: { name } });
    }
    for (const statement of backfillStatements()) {
      await prisma.$executeRawUnsafe(statement);
    }
  });

  afterAll(async () => {
    await prisma.department.deleteMany({ where: { name: { in: NAMES } } });
  });

  it("assigns every department the group the old classifier would have", async () => {
    const rows = await prisma.department.findMany({
      where: { name: { in: NAMES } },
      select: { name: true, reportGroup: true },
    });
    expect(rows).toHaveLength(NAMES.length);

    const mismatches = rows
      .filter((r) => r.reportGroup !== oldCategoryFor(r.name))
      .map((r) => `${r.name}: got ${r.reportGroup}, old classifier said ${oldCategoryFor(r.name)}`);
    expect(mismatches).toEqual([]);
  });

  it("excludes exactly what the old EXCLUDED list excluded", async () => {
    const excluded = await prisma.department.findMany({
      where: { name: { in: NAMES }, reportGroup: null },
      select: { name: true },
    });
    expect(excluded.map((e) => e.name).sort()).toEqual(
      NAMES.filter((n) => oldCategoryFor(n) === null).sort(),
    );
  });

  it("flags exactly the old TARGET_DEPTS as cross-sell targets", async () => {
    const targets = await prisma.department.findMany({
      where: { name: { in: NAMES }, crossSellTarget: true },
      select: { name: true },
    });
    expect(targets.map((t) => t.name).sort()).toEqual(
      NAMES.filter((n) => OLD_TARGETS.includes(n)).sort(),
    );
  });

  it("anchors on Furniture, and on nothing else", async () => {
    const anchors = await prisma.department.findMany({
      where: { name: { in: NAMES }, crossSellAnchor: true },
      select: { name: true },
    });
    expect(anchors.map((a) => a.name)).toEqual(["Furniture"]);
  });
});
