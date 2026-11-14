// /app/__tests__/genericExportColumns.test.ts
//
// The data export's column allowlist, held to the schema (CLAUDE.md rule 65).
// The export used to read every column and strip a short list of known secret
// names, so StaffMember.pinHash went out in the Staff CSV because nobody had
// listed it. Now each entity names its columns (lib/genericExport.ts), and this
// test is the manifest that keeps that list honest in both directions:
//
// - every scalar column of every exported model is either exported or excluded
//   below with a reason, so a column a migration adds fails here until someone
//   decides whether it goes out (a silent omission would quietly break the
//   "your data is always yours" promise; a silent inclusion is the leak);
// - an exclusion for a column the model no longer has, or one the catalog now
//   exports, is stale and fails;
// - no exported column carries a credential-shaped name unless it is accepted
//   below with a reason, and an acceptance that no longer applies fails.

import { readFileSync } from "fs";
import { join } from "path";
import { EXPORT_ENTITIES } from "@/lib/genericExport";

const SCHEMA = join(__dirname, "..", "prisma", "schema.prisma");

/** Columns of exported models that deliberately stay out, each with why. */
const EXCLUDED: Record<string, string> = {
  "StaffMember.passwordHash":
    "Sign-in credential (scrypt hash). A hash is still an offline-guessable secret; porting staff means re-inviting them, not carrying hashes.",
  "StaffMember.pinHash":
    "Register PIN hash. A PIN is 4 to 8 digits, so its hash falls to brute force in seconds once it leaves the database.",
  "StaffMember.pinFailedAttempts":
    "PIN lockout counter: authentication state, not a business record anyone ports.",
  "StaffMember.pinLockedUntil":
    "PIN lockout expiry: authentication state, not a business record anyone ports.",
};

/**
 * Exported columns whose NAME looks like a credential but whose content is
 * not one, each with why. Empty today; an entry here is an argument in writing.
 */
const ACCEPTED_CREDENTIAL_NAMES: Record<string, string> = {};

/**
 * Names that look like a credential. `pin` is matched as a camelCase word
 * (pinHash, pinLockedUntil, cardPin) so `pinned` and `shipping` stay out; `key`
 * only at the end, where it means a key rather than a keyword.
 */
function looksLikeCredential(field: string): boolean {
  if (
    /hash|secret|token|cipher|passw(or)?d|passcode|credential|api_?key|private_?key|key$/i.test(
      field,
    )
  ) {
    return true;
  }
  return /(^pin|Pin)(?![a-z])/.test(field);
}

/** model -> scalar column names (relations and back-relations left out). */
function scalarColumns(): Map<string, string[]> {
  const src = readFileSync(SCHEMA, "utf8");
  const models = new Set([...src.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]));
  const out = new Map<string, string[]>();
  for (const m of src.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const [, model, body] = m;
    const cols: string[] = [];
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("//") || t.startsWith("@@")) continue;
      const c = /^(\w+)\s+(\w+)/.exec(t);
      if (!c) continue;
      if (models.has(c[2])) continue; // a relation field, not a column
      if (c[2] === "Unsupported") continue;
      cols.push(c[1]);
    }
    out.set(model, cols);
  }
  return out;
}

const schema = scalarColumns();

describe("data export column allowlist", () => {
  it("parses the schema it is checking, so nothing below passes vacuously", () => {
    expect(schema.get("StaffMember")).toEqual(
      expect.arrayContaining(["passwordHash", "pinHash", "displayName"]),
    );
    // A relation field is not a column.
    expect(schema.get("StaffMember")).not.toContain("user");
    // The name test recognises what it was written for, and not its look-alikes.
    expect(
      ["pinHash", "passwordHash", "ciphertext", "sessionToken", "apiKey"].every(
        looksLikeCredential,
      ),
    ).toBe(true);
    expect(["pinned", "shipping", "shipsVia", "spinner", "keyword"].some(looksLikeCredential)).toBe(
      false,
    );
  });

  it("every exported entity reads a real model", () => {
    const missing = EXPORT_ENTITIES.filter((e) => !schema.has(e.model)).map((e) => e.model);
    expect(missing).toEqual([]);
  });

  it("exports only columns the model has, with no relation fields and no repeats", () => {
    const wrong: string[] = [];
    for (const e of EXPORT_ENTITIES) {
      const cols = new Set(schema.get(e.model) ?? []);
      for (const c of e.columns) if (!cols.has(c)) wrong.push(`${e.key}: ${e.model}.${c}`);
      if (new Set(e.columns).size !== e.columns.length) wrong.push(`${e.key}: repeated column`);
    }
    expect(wrong).toEqual([]);
  });

  it("classifies every column of every exported model: exported, or excluded with a reason", () => {
    const unclassified: string[] = [];
    for (const e of EXPORT_ENTITIES) {
      for (const c of schema.get(e.model) ?? []) {
        const key = `${e.model}.${c}`;
        if (!e.columns.includes(c) && !(key in EXCLUDED)) unclassified.push(key);
      }
    }
    expect(unclassified).toEqual([]);
  });

  it("lists no exclusion that is exported or no longer exists (a stale manifest)", () => {
    const stale: string[] = [];
    for (const key of Object.keys(EXCLUDED)) {
      const [model, col] = key.split(".");
      const entities = EXPORT_ENTITIES.filter((e) => e.model === model);
      if (!schema.get(model)?.includes(col)) stale.push(`${key}: not in schema`);
      else if (entities.length === 0) stale.push(`${key}: model is not exported`);
      else if (entities.some((e) => e.columns.includes(col))) stale.push(`${key}: exported`);
    }
    expect(stale).toEqual([]);
  });

  it("exports no column with a credential-shaped name unless it is accepted in writing", () => {
    const leaks: string[] = [];
    for (const e of EXPORT_ENTITIES) {
      for (const c of e.columns) {
        const key = `${e.model}.${c}`;
        if (looksLikeCredential(c) && !(key in ACCEPTED_CREDENTIAL_NAMES)) leaks.push(key);
      }
    }
    expect(leaks).toEqual([]);
  });

  it("accepts no credential-shaped name that is no longer exported or no longer matches", () => {
    const stale = Object.keys(ACCEPTED_CREDENTIAL_NAMES).filter((key) => {
      const [model, col] = key.split(".");
      const exported = EXPORT_ENTITIES.some((e) => e.model === model && e.columns.includes(col));
      return !exported || !looksLikeCredential(col);
    });
    expect(stale).toEqual([]);
  });

  it("gives every exclusion and acceptance a reason worth reading", () => {
    for (const reason of [
      ...Object.values(EXCLUDED),
      ...Object.values(ACCEPTED_CREDENTIAL_NAMES),
    ]) {
      expect(reason.length).toBeGreaterThan(40);
    }
  });
});
