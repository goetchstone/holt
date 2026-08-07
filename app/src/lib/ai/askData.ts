// /app/src/lib/ai/askData.ts
//
// The one function the chat endpoint calls: question in, {sql, rows} out. It
// wires the three seams together -- schema description, the active provider's
// text-to-SQL, and the read-only executor -- and owns the two non-happy paths:
//
//   refused -- the model produced something that is not a read-only SELECT. We
//              return the offending SQL (so it is visible) with no rows, rather
//              than running it. The isReadOnly check in runSelect is the same
//              guard; checking here lets us distinguish "refused" from "failed".
//   error   -- the query was read-only but the database rejected it (bad
//              identifier, timeout, syntax). Surfaced as a string via
//              getErrorMessage (CLAUDE.md rule 11) rather than thrown, so the UI
//              can show the SQL alongside the reason it did not run.

import { getActiveAiProvider } from "@/lib/ai/registry";
import { isReadOnly, runSelect, schemaText } from "@/lib/ai/sql";
import { getErrorMessage } from "@/lib/toastError";

export interface AskDataResult {
  sql: string;
  columns: string[];
  rows: unknown[];
  /** The model returned something that is not a read-only SELECT; nothing ran. */
  refused?: boolean;
  /** The SELECT was valid to attempt but the database rejected it. */
  error?: string;
}

export async function askData(question: string): Promise<AskDataResult> {
  const schema = await schemaText();
  const sql = await getActiveAiProvider().generateSql(question, schema);

  if (!isReadOnly(sql)) {
    return { sql, columns: [], rows: [], refused: true };
  }

  try {
    const result = await runSelect(sql);
    return { sql, ...result };
  } catch (err) {
    return { sql, columns: [], rows: [], error: getErrorMessage(err, "Query failed.") };
  }
}
