// /app/__tests__/stockWriterTripwire.test.ts
//
// lib/inventory/ledger.ts is the ONLY code allowed to write InventoryPosition.
//
// Before it existed, nine files wrote the table, each with its own arithmetic,
// and four of them upserted through a unique key that holds two nullable
// columns. Postgres treats NULLs as distinct there, so those upserts never
// matched a free-stock row and every receipt, restock and transfer cancel
// created another duplicate (CLAUDE.md rule 64). A transfer whose source row was
// missing shipped nothing and received stock at the destination anyway. One
// writer fixes the whole class -- but only while it stays the only one, and a
// new route that "just updates the quantity" would quietly bring it all back.
// That is principle 3: a guard on one path is no guard.
//
// This is a manifest and a tripwire (rule 65), and it fails in BOTH directions:
//   - a file writes the table but is not in WRITERS: a new writer slipped in;
//   - a file is in WRITERS but no longer writes it: the manifest is stale and
//     overstates where writes happen.
//
// Scope: production code (src/), the demo seed and scripts. Tests are excluded
// on purpose -- fixtures create positions directly to build the state a test
// needs, and that is what fixtures are for.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const APP_DIR = join(__dirname, "..");
const SCAN_ROOTS = ["src", "prisma/seed", "scripts"];

/** Every file allowed to write InventoryPosition, each with why. */
const WRITERS: Record<string, string> = {
  "src/lib/inventory/ledger.ts":
    "The single writer: postMovement, setPlaceQuantity and dropEmptyRow. Every other path calls these.",
};

const PRISMA_WRITE =
  /\binventoryPosition\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\s*\(/;
const RAW_SQL_WRITE =
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(public"?\.)?"?InventoryPosition"?\b/i;

/** Code lines only: a write described in a comment is not a write. */
function codeLines(source: string): string[] {
  return source.split("\n").filter((line) => {
    const t = line.trimStart();
    return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("--"));
  });
}

function filesUnder(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out = out.concat(filesUnder(full));
    else if (/\.(ts|tsx|js|mjs|cjs|sql)$/.test(name)) out.push(full);
  }
  return out;
}

export function findWriters(appDir: string): string[] {
  const writers = new Set<string>();
  for (const root of SCAN_ROOTS) {
    for (const file of filesUnder(join(appDir, root))) {
      const lines = codeLines(readFileSync(file, "utf8"));
      if (lines.some((l) => PRISMA_WRITE.test(l) || RAW_SQL_WRITE.test(l))) {
        writers.add(relative(appDir, file).split("\\").join("/"));
      }
    }
  }
  return Array.from(writers).sort();
}

describe("InventoryPosition has exactly one writer", () => {
  const found = findWriters(APP_DIR);

  it("no file outside the manifest writes InventoryPosition", () => {
    const unlisted = found.filter((f) => !(f in WRITERS));
    if (unlisted.length > 0) {
      throw new Error(
        `These files write InventoryPosition directly:\n  ${unlisted.join("\n  ")}\n` +
          "Move the stock through lib/inventory/ledger.ts (postMovement, or setPlaceQuantity " +
          "for a stated on-hand) instead. It locks the product, merges into the existing row " +
          "for a place and never goes negative; a direct write does none of that.",
      );
    }
  });

  it("every file in the manifest still writes it (the manifest is not stale)", () => {
    const stale = Object.keys(WRITERS).filter((f) => !found.includes(f));
    expect(stale).toEqual([]);
  });

  it("every manifest entry says why it is allowed", () => {
    for (const [file, reason] of Object.entries(WRITERS)) {
      expect({ file, hasReason: reason.trim().length > 20 }).toEqual({ file, hasReason: true });
    }
  });

  it("recognises both Prisma and raw-SQL writes, and ignores comments", () => {
    expect(PRISMA_WRITE.test("await tx.inventoryPosition.upsert({")).toBe(true);
    expect(PRISMA_WRITE.test("prisma.inventoryPosition.deleteMany({ where })")).toBe(true);
    expect(PRISMA_WRITE.test("tx.inventoryPosition.findMany({")).toBe(false);
    expect(RAW_SQL_WRITE.test('UPDATE "InventoryPosition" SET quantity = 0')).toBe(true);
    expect(RAW_SQL_WRITE.test('DELETE FROM "public"."InventoryPosition"')).toBe(true);
    expect(RAW_SQL_WRITE.test('SELECT * FROM "InventoryPosition"')).toBe(false);
    expect(codeLines("// tx.inventoryPosition.update(\nreal();")).toEqual(["real();"]);
  });
});
