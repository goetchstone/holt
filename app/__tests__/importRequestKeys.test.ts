// /app/__tests__/importRequestKeys.test.ts
//
// Import routes key lookups by text from the upload: collection names, grade
// codes, multipart field names. Keyed into a plain `{}`, a name like
// `__proto__` is dropped on write and `constructor` reads back an inherited
// function instead of "not found" (CodeQL js/remote-property-injection
// #25-#38). The pricing routes now build those lookups as Maps, collections
// through one shared helper; the purchasing routes read an allowlist of field
// names. These tests feed both helpers the names that broke the old shape.

import type { Fields } from "formidable";
import { upsertCollectionIds } from "@/lib/pricing/upsertCollectionIds";
import { pickFormFields } from "@/lib/importFormFields";

const HOSTILE_NAMES = ["__proto__", "constructor", "toString", "hasOwnProperty"];

/** Stands in for the transaction client: the database part is one upsert per
 *  name, and what is under test is how the returned ids are keyed. */
function collectionClient() {
  const rows = new Map<string, number>();
  const upserts: string[] = [];
  const tx = {
    collection: {
      upsert: async (args: { create: { name: string } }) => {
        const { name } = args.create;
        upserts.push(name);
        if (!rows.has(name)) rows.set(name, rows.size + 1);
        return { id: rows.get(name)! };
      },
    },
  };
  return { tx: tx as unknown as Parameters<typeof upsertCollectionIds>[0], upserts };
}

describe("upsertCollectionIds", () => {
  it("keys every collection name as itself, including Object.prototype member names", async () => {
    const { tx, upserts } = collectionClient();
    const ids = await upsertCollectionIds(tx, 7, ["Aria", ...HOSTILE_NAMES]);

    expect([...ids]).toEqual([
      ["Aria", 1],
      ["__proto__", 2],
      ["constructor", 3],
      ["toString", 4],
      ["hasOwnProperty", 5],
    ]);
    expect(upserts).toEqual(["Aria", ...HOSTILE_NAMES]);
  });

  it("upserts a repeated name once", async () => {
    const { tx, upserts } = collectionClient();
    const ids = await upsertCollectionIds(tx, 7, ["Aria", "Bella", "Aria"]);

    expect(upserts).toEqual(["Aria", "Bella"]);
    expect([...ids.keys()]).toEqual(["Aria", "Bella"]);
  });
});

describe("pickFormFields", () => {
  const NAMES = ["departmentId", "categoryId", "itemCategories"] as const;

  it("returns the first value of each named field and nothing else", () => {
    // JSON.parse makes `__proto__` an own key, as a JSON-bodied form would.
    const raw = JSON.parse(
      JSON.stringify({
        departmentId: ["5", "6"],
        itemCategories: ['{"0":3}'],
        constructor: ["evil"],
        hasOwnProperty: ["evil"],
      }).replace("{", '{"__proto__":{"departmentId":["9"]},'),
    ) as Fields;

    const fields = pickFormFields(raw, NAMES);

    expect(fields).toEqual({ departmentId: "5", categoryId: "", itemCategories: '{"0":3}' });
    expect(Object.keys(fields)).toEqual([...NAMES]);
    expect(Object.getPrototypeOf(fields)).toBe(Object.prototype);
    expect(fields.constructor).toBe(Object);
  });

  it("does not read a named field through the prototype chain", () => {
    const raw = Object.create({ departmentId: ["9"] }) as Fields;

    expect(pickFormFields(raw, NAMES).departmentId).toBe("");
  });
});
