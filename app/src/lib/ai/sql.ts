// /app/src/lib/ai/sql.ts
//
// The read-only SQL boundary for the AI chatbot. Everything a model-generated
// query has to pass through before it touches the tenant's database lives here,
// in one file, so the safety story is auditable in one place (CLAUDE.md rule
// 42: a guard is one shared function on every path that needs it).
//
// Three concerns, deliberately separate:
//   isReadOnly  -- the string-level gate (SELECT/CTE only, no DML/DDL keyword).
//   schemaText  -- the schema description handed to the model as context.
//   runSelect   -- execution, behind the gate, with a statement timeout + row cap.
//
// The gate is defence-in-depth, NOT the only defence: a dedicated read-only DB
// role (AI_DB_URL) is the real perimeter in later phases. But a string check
// that refuses anything not obviously a read is cheap and catches the model
// wandering long before Postgres does.

import { prisma } from "@/lib/prisma";
import { isTableAllowed, referencesDeniedTable } from "@/lib/ai/tableAccess";

// Word-boundary match so "created_at" or "updatedBy" as an identifier does not
// trip the guard, but a bare `DROP` / `DELETE` keyword does. Case-insensitive.
const FORBIDDEN_KEYWORDS =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|copy)\b/i;

/**
 * True only when `sql` is unambiguously a read: it starts with SELECT or WITH
 * (a CTE), and contains no mutating/DDL keyword anywhere. Both conditions must
 * hold -- a query that starts with SELECT but smuggles a data-modifying CTE
 * (`WITH x AS (DELETE ...)`) is rejected by the keyword check.
 */
export function isReadOnly(sql: string): boolean {
  const trimmed = sql.trim();
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith("select") && !lower.startsWith("with")) return false;
  if (FORBIDDEN_KEYWORDS.test(trimmed)) return false;
  // Read-only is not the same as harmless. `SELECT * FROM "IntegrationCredential"`
  // is a perfectly well-formed read; so is dumping every session token. The
  // keyword gate above only asks whether the statement WRITES.
  return !referencesDeniedTable(trimmed);
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
}

interface ForeignKeyRow {
  table_name: string;
  column_name: string;
  foreign_table_name: string;
  foreign_column_name: string;
}

/**
 * A compact, model-friendly description of the tenant's public schema, one line
 * per table: `"Table"(col type, col type, ...)`, followed by a
 * "Relationships (foreign keys):" section that spells out each FK as
 * `"Table"."col" -> "ForeignTable"."col"`. Column names alone do not tell the
 * model that `SalesOrder."customerId"` points at `Customer` and
 * `SalesOrder."salesPersonId"` at `StaffMember`; the FK lines make the join
 * targets explicit so it stops guessing. Identifiers are double-quoted to
 * remind the model they are case-sensitive in this database (the models use
 * camelCase column names such as "firstName").
 */
export async function schemaText(): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<ColumnRow[]>(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position`,
  );

  const byTable = new Map<string, string[]>();
  for (const row of rows) {
    // Not shown to the model. runSelect refuses these too -- see tableAccess.ts
    // for why omitting them from the prompt is not on its own a control.
    if (!isTableAllowed(row.table_name)) continue;
    const cols = byTable.get(row.table_name) ?? [];
    cols.push(`${row.column_name} ${row.data_type}`);
    byTable.set(row.table_name, cols);
  }

  const lines: string[] = [];
  for (const [table, cols] of byTable) {
    lines.push(`"${table}"(${cols.join(", ")})`);
  }

  const fkLines = await foreignKeyLines();
  if (fkLines.length > 0) {
    lines.push("", "Relationships (foreign keys):", ...fkLines);
  }

  return lines.join("\n");
}

/**
 * One line per foreign key, `"Table"."col" -> "ForeignTable"."col"`, read from
 * information_schema. Compact on purpose: the join target is the whole point,
 * so nothing else (constraint name, action) is included.
 */
async function foreignKeyLines(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<ForeignKeyRow[]>(
    `SELECT tc.table_name,
            kcu.column_name,
            ccu.table_name  AS foreign_table_name,
            ccu.column_name AS foreign_column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema = tc.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
      ORDER BY tc.table_name, kcu.column_name`,
  );

  return rows
    .filter((r) => isTableAllowed(r.table_name) && isTableAllowed(r.foreign_table_name))
    .map(
      (r) =>
        `"${r.table_name}"."${r.column_name}" -> "${r.foreign_table_name}"."${r.foreign_column_name}"`,
    );
}

/**
 * Run a read-only SELECT and return its columns + capped rows. Refuses anything
 * isReadOnly rejects. Wraps the query in a transaction that first sets a
 * per-transaction statement_timeout (SET LOCAL is scoped to the transaction, so
 * it cannot leak onto a pooled connection) -- a runaway query the model wrote
 * is killed by Postgres rather than tying up a connection.
 */
export async function runSelect(
  sql: string,
  limit = 50,
): Promise<{ columns: string[]; rows: unknown[]; truncated: boolean }> {
  if (!isReadOnly(sql)) {
    throw new Error(
      "Refusing to run a statement that is not a read-only SELECT, or that references a table the assistant may not read.",
    );
  }

  // The cap has to be applied by Postgres, not by slicing afterwards. A model
  // that writes `SELECT * FROM "OrderLineItem"` on a real deployment returns
  // millions of rows; slicing to 50 after the fact still pulls all of them
  // through the driver and into this process first. The statement timeout does
  // not save you -- a fast sequential scan returns a great deal in ten seconds.
  //
  // Wrapping as a subquery rather than appending LIMIT, because the model's SQL
  // may already end in its own LIMIT, an ORDER BY, or a trailing semicolon.
  const capped = `SELECT * FROM (${sql.trim().replace(/;\s*$/, "")}) AS ai_capped LIMIT ${Math.floor(limit) + 1}`;

  const rows = await prisma.$transaction(async (tx) => {
    // SET LOCAL scopes the timeout to this transaction only.
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10s'");
    return tx.$queryRawUnsafe<Record<string, unknown>[]>(capped);
  });

  // One extra row was requested so "there is more" is knowable without a
  // second query; it is dropped before returning.
  const truncated = rows.length > limit;
  const page = rows.slice(0, limit);
  const columns = page.length > 0 ? Object.keys(page[0]) : [];
  return { columns, rows: page, truncated };
}
