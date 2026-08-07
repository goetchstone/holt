// /app/src/lib/ai/prompt.ts
//
// The text-to-SQL prompt, in one place so every provider (ollama today,
// Anthropic / OpenAI in phase 3) speaks to its model with the same rules,
// domain hints, and worked example. Providers own transport; this file owns
// what we ask for. Keeping it separate means an accuracy fix (a sharper hint, a
// new few-shot) lands once and reaches every backend (CLAUDE.md rule 6: one
// source of truth per concept).
//
// The domain hints exist because the local model, given only column names,
// cannot tell that `SalesOrder."customerId"` is the buyer and
// `SalesOrder."salesPersonId"` is the staff who made the sale -- both are just
// integer FKs to a person. "What did <person> order?" must resolve through
// `customerId`; a model left to guess picks salesPersonId about as often, and
// silently answers a different question.

/** One chat turn. Matches the {role, content} shape every provider's API uses. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// The model is told exactly one job. The double-quote instruction matters: the
// schema uses camelCase identifiers ("firstName", "Customer"), which Postgres
// folds to lowercase unless quoted, so an unquoted identifier silently 404s.
export const SYSTEM = [
  "You are a PostgreSQL expert. Translate the user's question into ONE read-only",
  "SQL query against the provided schema.",
  "",
  "Rules:",
  '- Output a single SELECT statement (a leading WITH/CTE is fine). NEVER write',
  "  INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, GRANT, REVOKE, MERGE, or COPY.",
  "- ALWAYS double-quote table and column identifiers, because they are",
  '  case-sensitive in this database. Example: SELECT "firstName" FROM "Customer".',
  "- Add LIMIT 50 to the query unless it is an aggregate (COUNT/SUM/AVG/etc.).",
  "- Reply with ONLY the SQL, inside a single ```sql code block. No prose.",
  "",
  "Domain hints:",
  '- A person\'s PURCHASES join `SalesOrder` to `Customer` via',
  '  `SalesOrder."customerId" = Customer."id"`. `SalesOrder."salesPersonId"` is the',
  "  STAFF member who made the sale, NOT the buyer -- never use it to answer what a",
  "  customer bought.",
  "- Match person names case-insensitively and split first/last, e.g.",
  `  \`WHERE "firstName" ILIKE 'christine' AND "lastName" ILIKE 'dwyer'\` -- spellings vary.`,
  "",
  "Example",
  "Question: what did Jane Smith order?",
  "```sql",
  'SELECT oli."productName", SUM(oli."orderedQuantity") AS "totalQuantity"',
  'FROM "OrderLineItem" oli',
  'JOIN "SalesOrder" so ON so."id" = oli."salesOrderId"',
  'JOIN "Customer" c ON c."id" = so."customerId"',
  `WHERE c."firstName" ILIKE 'jane' AND c."lastName" ILIKE 'smith'`,
  'GROUP BY oli."productName"',
  'ORDER BY "totalQuantity" DESC',
  "LIMIT 50",
  "```",
].join("\n");

/**
 * Build the full message list for a text-to-SQL request: the shared system
 * prompt plus the user's question with the schema as context. Providers pass
 * the returned array straight to their chat API, so the prompt stays identical
 * across backends.
 */
export function buildMessages(question: string, schema: string): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: "Schema:\n" + schema + "\n\nQuestion: " + question },
  ];
}
