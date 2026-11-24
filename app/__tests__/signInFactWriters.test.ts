// /app/__tests__/signInFactWriters.test.ts
//
// Rule 65 for the facts that decide who can sign in as a staff member. Every
// file under src that writes a StaffMember or User row is listed in
// fixtures/sign-in-fact-writers.txt with a class and a reason; this test finds
// the writers itself and fails in BOTH directions:
//
//   - a file that writes and is not listed (a new writer nobody judged);
//   - a listed file that no longer writes (a stale manifest);
//   - a 'guarded' file that does not call the sign-in rule;
//   - a line with no reason;
//   - a 'no-sign-in-fact' file whose literal writes name a column it did not
//     declare, or put email, isActive, userId or passwordHash on a StaffMember
//     (a write whose data the test cannot read is refused for that class).
//
// Until 2026-11-21 the Staff routes wrote a member's email, active status and
// login link on staff.manage alone (pages/api/staff/[id].ts), which made a
// General Manager able to sign in as the Owner. The rule now lives in
// lib/auth/roleAssignment.ts (signInChangeRefusal); this keeps a new writer
// from going around it unseen.
//
// Writers are found with the TypeScript parser, not a regex over the text:
// `<anything>.staffMember.<write>(...)` and `<anything>.user.<write>(...)`, raw
// SQL that inserts, updates or deletes those tables, and the NextAuth
// PrismaAdapter (which writes User rows).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const APP = join(__dirname, "..");
const SRC = join(APP, "src");
const MANIFEST = join(__dirname, "fixtures", "sign-in-fact-writers.txt");

const MODELS = new Set(["staffMember", "user"]);
const WRITES = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
]);
const RAW_WRITE = /\b(?:insert\s+into|update|delete\s+from)\s+"(?:StaffMember|User)"/i;
const SIGN_IN_FACTS = new Set(["email", "isActive", "userId", "passwordHash"]);
const SIGN_IN_RULE = /\b(?:signInChangeRefusal|signInRefusalFor)\s*\(/;
const CLASSES = new Set(["guarded", "self", "token", "identity-proof", "no-sign-in-fact"]);

interface Write {
  model: string;
  /** Column names a literal write sets; null when the test cannot read them. */
  columns: string[] | null;
}

interface FileWrites {
  writes: Write[];
  raw: boolean;
  adapter: boolean;
}

interface Entry {
  path: string;
  cls: string;
  columns: string[];
  reason: string;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

/** The property names of an object literal; null when one is spread or computed. */
function keysOf(node: ts.Expression): string[] | null {
  if (ts.isArrayLiteralExpression(node)) {
    const all = node.elements.map((e) => keysOf(e));
    return all.includes(null) ? null : [...new Set(all.flat() as string[])];
  }
  if (!ts.isObjectLiteralExpression(node)) return null;
  const keys: string[] = [];
  for (const p of node.properties) {
    if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name) {
      if (!ts.isIdentifier(p.name) && !ts.isStringLiteral(p.name)) return null;
      keys.push(p.name.text);
    } else {
      return null;
    }
  }
  return keys;
}

/** The columns a write call sets: its data, or an upsert's create and update. */
function columnsOf(call: ts.CallExpression, method: string): string[] | null {
  if (method === "delete" || method === "deleteMany") return [];
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
  const parts = method === "upsert" ? ["create", "update"] : ["data"];
  const found: string[] = [];
  for (const part of parts) {
    const prop = arg.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === part,
    );
    if (!prop) return null;
    const keys = keysOf(prop.initializer);
    if (!keys) return null;
    found.push(...keys);
  }
  return [...new Set(found)];
}

function scan(file: string): FileWrites {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const result: FileWrites = { writes: [], raw: false, adapter: false };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const owner = node.expression.expression;
      if (
        WRITES.has(method) &&
        ts.isPropertyAccessExpression(owner) &&
        MODELS.has(owner.name.text)
      ) {
        result.writes.push({ model: owner.name.text, columns: columnsOf(node, method) });
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "PrismaAdapter") result.adapter = true;
    }
    if (
      (ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isStringLiteral(node)) &&
      RAW_WRITE.test(node.text)
    ) {
      result.raw = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

function writesAnything(w: FileWrites): boolean {
  return w.writes.length > 0 || w.raw || w.adapter;
}

function readManifest(): Entry[] {
  return readFileSync(MANIFEST, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [path = "", cls = "", columns = "", ...reason] = line.split("|").map((s) => s.trim());
      return {
        path,
        cls,
        columns:
          columns === "-"
            ? []
            : columns
                .split(",")
                .map((c) => c.trim())
                .filter(Boolean),
        reason: reason.join("|").trim(),
      };
    });
}

/** Every failure the manifest and the source disagree on, as readable lines. */
function manifestFailures(
  entries: Entry[],
  found: Map<string, FileWrites>,
  textOf: (path: string) => string,
): string[] {
  const failures: string[] = [];
  const listed = new Map(entries.map((e) => [e.path, e]));
  for (const [path, w] of found) {
    if (writesAnything(w) && !listed.has(path)) {
      failures.push(`${path}: writes StaffMember or User but is not in the manifest`);
    }
  }
  for (const e of entries) failures.push(...entryFailures(e, found.get(e.path), textOf));
  return failures;
}

function entryFailures(
  e: Entry,
  w: FileWrites | undefined,
  textOf: (path: string) => string,
): string[] {
  if (!w || !writesAnything(w)) {
    return [`${e.path}: listed, but no longer writes StaffMember or User (stale line)`];
  }
  const failures: string[] = [];
  if (!CLASSES.has(e.cls)) failures.push(`${e.path}: unknown class '${e.cls}'`);
  if (!e.reason) failures.push(`${e.path}: no reason given`);
  if (e.cls === "guarded" && !SIGN_IN_RULE.test(textOf(e.path))) {
    failures.push(`${e.path}: 'guarded' but never calls signInChangeRefusal or signInRefusalFor`);
  }
  if (e.cls === "no-sign-in-fact") failures.push(...columnFailures(e, w));
  return failures;
}

function columnFailures(e: Entry, w: FileWrites): string[] {
  const failures: string[] = [];
  if (e.columns.length === 0) failures.push(`${e.path}: 'no-sign-in-fact' must name its columns`);
  if (w.raw)
    failures.push(`${e.path}: 'no-sign-in-fact' writes by raw SQL, which this cannot read`);
  for (const write of w.writes) {
    if (write.columns === null) {
      failures.push(`${e.path}: a ${write.model} write whose columns are not a plain literal`);
      continue;
    }
    for (const col of write.columns) {
      if (write.model === "staffMember" && SIGN_IN_FACTS.has(col)) {
        failures.push(`${e.path}: writes the sign-in fact StaffMember.${col}`);
      } else if (!e.columns.includes(col)) {
        failures.push(`${e.path}: writes ${write.model}.${col}, not among its declared columns`);
      }
    }
  }
  return failures;
}

const sources = walk(SRC).filter((f) => !/\.test\.tsx?$/.test(f));
const found = new Map(sources.map((f) => [relative(APP, f), scan(f)]));
const textOf = (path: string) => readFileSync(join(APP, path), "utf8");

describe("every writer of a sign-in fact is listed and judged (rule 65)", () => {
  it("finds the writers it was written for, so the scan is not silently empty", () => {
    const writers = [...found].filter(([, w]) => writesAnything(w)).map(([p]) => p);
    expect(writers).toEqual(
      expect.arrayContaining([
        "src/pages/api/staff/[id].ts",
        "src/pages/api/auth/[...nextauth].ts",
        "src/lib/auth/passwordReset.ts",
      ]),
    );
  });

  it("agrees with the manifest in both directions", () => {
    expect(manifestFailures(readManifest(), found, textOf)).toEqual([]);
  });

  describe("the check itself can fail", () => {
    const entries = readManifest();
    const ordinary = "src/pages/api/staff/active-store.ts";

    it("on an unlisted writer", () => {
      const without = entries.filter((e) => e.path !== ordinary);
      expect(manifestFailures(without, found, textOf)).toEqual([
        `${ordinary}: writes StaffMember or User but is not in the manifest`,
      ]);
    });

    it("on a stale line", () => {
      const extra = { path: "src/lib/prisma.ts", cls: "self", columns: [], reason: "x" };
      expect(manifestFailures([...entries, extra], found, textOf)).toEqual([
        "src/lib/prisma.ts: listed, but no longer writes StaffMember or User (stale line)",
      ]);
    });

    it("on a 'no-sign-in-fact' file that writes a sign-in fact, and on a missing reason", () => {
      const planted = new Map(found);
      planted.set(ordinary, {
        writes: [{ model: "staffMember", columns: ["activeStoreLocationId", "email"] }],
        raw: false,
        adapter: false,
      });
      const unreasoned = entries.map((e) => (e.path === ordinary ? { ...e, reason: "" } : e));
      expect(manifestFailures(unreasoned, planted, textOf)).toEqual([
        `${ordinary}: no reason given`,
        `${ordinary}: writes the sign-in fact StaffMember.email`,
      ]);
    });

    it("on a 'guarded' file that does not call the rule", () => {
      const guarded = "src/pages/api/staff/index.ts";
      const stripped = (path: string) =>
        path === guarded ? textOf(path).replaceAll("signInRefusalFor(", "x(") : textOf(path);
      expect(manifestFailures(entries, found, stripped)).toEqual([
        `${guarded}: 'guarded' but never calls signInChangeRefusal or signInRefusalFor`,
      ]);
    });
  });
});
