// /app/src/lib/ai/types.ts
//
// The AI-provider seam for the data chatbot. Same shape as the source-adapter
// registry (lib/adapters/): one active provider per deployment, chosen by an
// operator (an env var in phase 1), resolved at the call site. A provider owns
// exactly ONE thing here -- turning a natural-language question plus a schema
// description into a single SQL string. It does NOT run the SQL, guard it, or
// know what a tenant is; that stays behind lib/ai/sql.ts so a second provider
// (Anthropic / OpenAI in phase 3) is a registration, not a new safety story.

/**
 * One text-to-SQL backend (local ollama today; cloud providers later). The id
 * is stable and resolved by lib/ai/registry.ts; label is for an admin picker.
 */
export interface AiProvider {
  /** Stable id. Resolved from AI_PROVIDER; renaming is an operator-visible change. */
  id: string;
  /** Shown in the provider picker. Never includes secrets. */
  label: string;
  /**
   * Produce ONE read-only PostgreSQL SELECT for `question`, given a text
   * description of the tenant's schema. The returned string is untrusted: the
   * caller re-checks it with isReadOnly before it ever reaches the database.
   */
  generateSql(question: string, schema: string): Promise<string>;
}

/**
 * The result of answering a data question: the SQL that ran, the column names
 * in order, and the (row-capped) rows. Rows are `unknown` -- shape is
 * question-dependent and validated only at the display edge.
 */
export interface SqlResult {
  sql: string;
  columns: string[];
  rows: unknown[];
}
