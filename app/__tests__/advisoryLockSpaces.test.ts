// /app/__tests__/advisoryLockSpaces.test.ts
//
// Every two-key advisory lock names a key space: a number that says what kind
// of thing the second key identifies (a product, a payment, a return). Each
// lib file declares its own, so nothing but this test stops two of them
// choosing the same number. They would then wait on each other for no reason:
// a refund of payment 12 held up by stock moving on product 12, and no error
// to say why (rule 65: a countable set gets a check).
//
// Source text is right for this class: the property is "no two declarations
// share a number, and every lock uses a declared one".

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const APP = join(__dirname, "..");

function filesUnder(dir: string): string[] {
  return readdirSync(join(APP, dir)).flatMap((name) => {
    const path = `${dir}/${name}`;
    if (statSync(join(APP, path)).isDirectory()) return filesUnder(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** `const STOCK_LOCK_SPACE = 5_461_067;` */
const DECLARATION = /\bconst\s+(\w+_LOCK_SPACE)\s*=\s*([\d_]+)\s*;/g;
/** The first key of a two-key lock: `pg_advisory_xact_lock(${X}::int, ...` or the try form. */
const TWO_KEY_LOCK = /pg_(?:try_)?advisory(?:_xact)?_lock\(\s*([^,)]+),/g;

interface Found {
  declared: { name: string; space: number; file: string }[];
  firstKeys: { key: string; file: string }[];
}

function scan(): Found {
  const found: Found = { declared: [], firstKeys: [] };
  for (const file of filesUnder("src")) {
    const source = readFileSync(join(APP, file), "utf8");
    for (const m of source.matchAll(DECLARATION)) {
      found.declared.push({ name: m[1], space: Number(m[2].replace(/_/g, "")), file });
    }
    for (const m of source.matchAll(TWO_KEY_LOCK)) {
      found.firstKeys.push({ key: m[1].trim(), file });
    }
  }
  return found;
}

describe("advisory lock key spaces", () => {
  const { declared, firstKeys } = scan();

  it("finds the declarations and the locks that use them", () => {
    expect(declared.length).toBeGreaterThanOrEqual(9);
    expect(firstKeys.length).toBeGreaterThanOrEqual(declared.length);
  });

  it("gives every space its own number", () => {
    const bySpace = new Map<number, string[]>();
    for (const d of declared) {
      bySpace.set(d.space, [...(bySpace.get(d.space) ?? []), `${d.name} (${d.file})`]);
    }
    const shared = [...bySpace].filter(([, names]) => names.length > 1);
    expect(shared).toEqual([]);
  });

  it("takes every two-key lock in a declared space, never a bare number", () => {
    const names = new Set(declared.map((d) => d.name));
    const undeclared = firstKeys.filter(({ key }) => {
      const name = /^\$\{(\w+)\}::int$/.exec(key)?.[1];
      return name === undefined || !names.has(name);
    });
    expect(undeclared).toEqual([]);
  });

  it("has no declared space that nothing locks", () => {
    const used = new Set(firstKeys.map(({ key }) => /^\$\{(\w+)\}::int$/.exec(key)?.[1]));
    expect(declared.filter((d) => !used.has(d.name)).map((d) => d.name)).toEqual([]);
  });
});
