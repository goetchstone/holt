// /app/src/lib/ai/tableAccess.ts
//
// Which tables the assistant may see and read. One list, used by BOTH halves,
// because hiding a table from the prompt is not a control -- the model can name
// a table nobody showed it, and a user can ask for one by name.
//
//   schemaText() omits these, so the model is not invited to use them.
//   runSelect()  REFUSES a query mentioning them, so guessing does not work.
//
// Without the second half this is a suggestion. `User`, `Session`,
// `IntegrationCredential` and `PasswordResetToken` are exactly the tables an
// attacker would ask for by name, and "SELECT * FROM \"IntegrationCredential\""
// is a read-only SELECT: it passes every keyword check in sql.ts.
//
// A DENY list, not an allow list, deliberately. The point of the assistant is
// to answer questions about the business, and the business is ~150 tables that
// grow every release. An allow list would silently stop covering new ones, and
// the failure mode is a chatbot that says "I don't know" about a table someone
// added last week -- which is annoying but survivable. The deny list's failure
// mode is a secret leaking, so it is the one that gets the explicit test that
// every name in it still exists in the schema.

/**
 * Tables holding credentials, session material, or password-reset capability.
 * Nothing the assistant answers is worth exposing any of these.
 */
export const DENIED_TABLES: readonly string[] = [
  // NextAuth: session tokens and OAuth access/refresh tokens in the clear.
  "Account",
  "Session",
  "User",
  "VerificationToken",
  // A reset token is a password change. Reading one is taking over an account.
  "PasswordResetToken",
  // Encrypted third-party secrets (Stripe, SMTP, Gmail) + their IVs.
  "IntegrationCredential",
];

const DENIED_LOWER = new Set(DENIED_TABLES.map((t) => t.toLowerCase()));

/**
 * Postgres' own catalogs. Not in DENIED_TABLES because they are not in the
 * `public` schema and so never appear in schemaText() -- but a query can still
 * reach them by qualifying: `SELECT * FROM pg_catalog.pg_shadow`. Blocked by
 * prefix rather than by name because there are hundreds of them.
 */
const DENIED_SCHEMA_PREFIXES = ["pg_catalog.", "pg_toast.", "information_schema."];

/**
 * True when `sql` references a table it must not.
 *
 * Matching is on identifiers, so a customer literally called 'User Group' in a
 * string does not trip it, and `"User"`, `User`, `public."User"` and `PUBLIC.user`
 * all do. Postgres folds unquoted identifiers to lower case, so the comparison
 * is lower-cased on both sides -- a check that only caught the exact casing in
 * schema.prisma would be defeated by typing the name in lower case, which is
 * also how a model would most likely write it.
 */
export function referencesDeniedTable(sql: string): boolean {
  // Strip single-quoted literals first. A customer genuinely called 'Session'
  // must not break the assistant for the whole shop, and a table name inside a
  // string is not a table reference -- SQL cannot turn one into an identifier
  // without dynamic execution, which a plain SELECT has no way to reach.
  // Doubled quotes ('') are Postgres' escape and are consumed with the literal.
  const lower = sql.toLowerCase().replace(/'(?:[^']|'')*'/g, "''");
  if (DENIED_SCHEMA_PREFIXES.some((p) => lower.includes(p))) return true;

  // Identifier-ish runs: optional quotes, optional schema qualifier.
  const identifiers = lower.match(/"?[a-z_][a-z0-9_]*"?(?:\s*\.\s*"?[a-z_][a-z0-9_]*"?)?/g) ?? [];
  for (const raw of identifiers) {
    const bare = raw.replace(/"/g, "").replace(/\s+/g, "");
    const name = bare.includes(".") ? bare.slice(bare.lastIndexOf(".") + 1) : bare;
    if (DENIED_LOWER.has(name)) return true;
  }
  return false;
}

/** True when this table may be described to the model and queried. */
export function isTableAllowed(tableName: string): boolean {
  return !DENIED_LOWER.has(tableName.toLowerCase());
}
