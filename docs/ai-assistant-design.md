# AI Assistant — Design

**Status:** design agreed, not yet built. Supersedes the *architecture* of
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

`CLAUDE.md` rule 33: *exclude cancelled lines from every sum and count.* That
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

> *"What did we sell last month?"*

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

| Requirement | How this delivers it |
|---|---|
| Never confabulate | The model cannot invent a number; numbers come from code. When no catalog entry matches, the only representable output is `unsupported`, and the UI says "I can't answer that — here's what I can answer." |
| Correct numbers | Catalog entries call `lib/reports/*`, which already carry rule 33, `SALES_REVENUE_STATUSES`, and every documented exception. The assistant is *by construction* consistent with the reports page. |
| "A specific set of data" | The catalog *is* the specific set. It is a file you can read in one sitting. |
| Injection-proof | No generated SQL means no SQL to escape from. The `IntegrationCredential` exfiltration class disappears rather than being filtered. |
| Cheap on metered APIs | The request is a stable catalog + one short question. Cacheable prefix, tiny completion. See §6. |
| Works on a 7B local model | "Pick an id from a numbered list and fill two fields" is within reach of small models in a way that "write correct PostgreSQL over 150 tables" is not. |
| Permission-aware | Each catalog entry declares the permission it needs; entries the caller lacks are filtered out **before** the prompt is built, so the model cannot offer what the user may not see. |

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
  type: "dateRange" | "storeId" | "salespersonId" | "productId" | "customerId" | "limit";
  required: boolean;
  description: string;   // shown to the model; keep it one line
}

export interface CatalogEntry {
  /** Stable id. Renaming is a breaking change for saved conversations. */
  id: string;
  /** One line, written for the model: what question this answers. */
  description: string;
  /** Phrasings a user might actually type. Helps small models route. */
  examples: string[];
  /** Capability required to run it. Checked server-side, never trusted from the model. */
  permission: string;
  params: CatalogParam[];
  /** Calls lib/reports/* — never raw SQL. */
  run(args: Record<string, unknown>, ctx: AnswerContext): Promise<AnswerTable>;
}
```

**Seed the catalog from the reports that already exist.** These are the entries
to ship in phase 1, each wrapping a function that is already correct and
already tested:

| id | wraps | permission |
|---|---|---|
| `sales.daily` | `reports/salesDaily.ts` | `reporting.read` |
| `sales.byPeriod` | `reports/comparativeSales.ts` | `reporting.read` |
| `sales.bySalesperson` | `reports/salesBySalespersonReport.ts` | `reporting.read` |
| `sales.topSellers` | `reports/topSellers.ts` | `reporting.read` |
| `orders.open` | `reports/openOrders.ts` | `reporting.read` |
| `orders.staleQuotes` | `reports/staleQuotes.ts` | `reporting.read` |
| `ar.balanceAging` | `reports/balanceAging.ts` | `accounting.read` |
| `inventory.health` | `reports/inventoryHealth.ts` | `reporting.read` |
| `customers.dormant` | `reports/dormantCustomers.ts` | `reporting.read` |
| `margin.gross` | `reports/grossMargin.ts` | `accounting.read` |

Ten entries answer the large majority of what anyone actually asks a
back-office assistant, and every one of them is already consistent with the
page the user would otherwise open.

> **Rule for every future entry:** a catalog entry MUST call a `lib/reports/*`
> or `lib/*` function. It must not contain a `$queryRaw`. If the answer needs a
> query that does not exist yet, write it in `lib/reports/` with its own test
> first, then wrap it. This is what keeps the assistant and the reports from
> drifting into two different truths.

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

| Provider id | Transport | Notes |
|---|---|---|
| `anthropic` | `@anthropic-ai/sdk` (add dependency) | Official SDK — do not use an OpenAI-compatible shim. |
| `openai` | OpenAI-compatible `/v1/chat/completions` | |
| `google` | `@google/genai` or REST | Distinct wire format; own file. |
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
  fine — roles are few and stable. Do **not** filter per *user*.
- **Completion is tiny** — an id and two args, tens of tokens.
- **Narration is opt-in.** `narrate()` doubles the round trips and sends result
  rows to the provider. Default it **off** for metered providers and **on** for
  local, via one setting (`AI_NARRATE`, default `provider.isLocal`). With it
  off, the UI renders the table plus a deterministic caption built in code —
  which is also strictly safer, since a narration step is the one place a model
  could still restate a number wrongly.
- **When narration is on**, constrain it: *"Restate only values present in the
  table. Do not compute new figures. Do not add context you were not given."*
  And keep the table small — narrate over the capped result, never the raw set.

Rough shape on Anthropic with caching and narration off: a few hundred cached
input tokens plus a handful of completion tokens per question. That is the
difference between an assistant a shop leaves switched on and one they turn
off after the first invoice.

---

## 7. What carries over from the guardrails branch

Branch `feat/ai-chatbot-guardrails` (already committed and pushed, no PR yet)
hardened the text-to-SQL path. Under this design most of it becomes belt-and-
braces rather than the primary control — **keep it anyway**, because it costs
nothing and it is what makes "no raw SQL" enforceable rather than aspirational:

- `lib/ai/tableAccess.ts` — the deny list (`User`, `Session`, `Account`,
  `VerificationToken`, `PasswordResetToken`, `IntegrationCredential`) plus the
  `pg_catalog` / `information_schema` prefix block, and the test asserting every
  denied name is a real model. Retain as a **defence-in-depth check on any
  future raw query**, and keep `__tests__/aiSqlGuard.test.ts` green.
- `chat.ts` on `permissionProcedure("reporting.read")` rather than
  `protectedProcedure` — carry forward, and additionally check each catalog
  entry's own `permission` at run time.
- The `LIMIT` wrapper in `runSelect` — keep for any raw path.

The finding that motivated all of it stays true and is worth keeping in the
commit history: **`SELECT * FROM "IntegrationCredential"` is a read-only query
that passes every keyword gate.** Read-only is not the same as harmless. The
catalog design retires that whole class of problem instead of filtering it.

---

## 8. Phasing

Each phase ships independently and is separately reviewable.

**Phase 1 — the catalog and the seam (the real work)**
1. `lib/ai/catalog.ts` — interface + the ten seed entries above.
2. `lib/ai/types.ts` — replace `generateSql` with `route`/`narrate`.
3. `lib/ai/answer.ts` — resolve entry → check permission → validate args →
   run → cap rows → return `AnswerTable`. Replaces `askData.ts`.
4. `lib/ai/providers/openaiCompatible.ts` + keep `ollama.ts` as a preset.
5. `server/trpc/routers/chat.ts` — swap to the new call; keep the permission
   procedure.
6. Tests: every entry resolves; a made-up id is `unsupported`; a caller without
   `accounting.read` never sees `ar.balanceAging` in the prompt **and** is
   refused if it is requested anyway.

**Phase 2 — UI**
`components/ai/ChatPanel.tsx` renders the table, the "I can't answer that"
state with the catalog listed, and a "this came from the Sales Daily report"
provenance line under every answer. That provenance line is not decoration —
it is how a user checks us.

**Phase 3 — cloud providers**
`providers/anthropic.ts`, `providers/google.ts`. Keys via
`lib/integrationCatalog.ts` + `resolveCredential` (encrypted at rest, same as
Stripe/SMTP — never an env var in a multi-tenant deployment). Add
`AppSettings.aiProviderId` + migration. Prompt caching per §6.

**Phase 4 — coverage**
Grow the catalog based on what real users ask. Log every `unsupported` with the
question text (behind a setting) — that log *is* the backlog, and it is the
only honest way to decide what to build next.

**Explicitly out of scope for now**
- Customer-facing chat. Different threat model entirely (unauthenticated,
  hostile input, no permission context). The catalog design is a good
  foundation for it later, but do not conflate the two.
- An MCP server. One deployment = one tenant = one database
  (`docs/TENANCY.md`); the tools are in-process `lib/` functions. MCP exposes
  tools to *external* clients, which is a different product. Revisit only if
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
exceptions are named rather than implicit, and a new report opts *out*
explicitly instead of forgetting to opt in.

This should be done **whether or not the assistant ships**, and doing it first
makes the assistant smaller: catalog entries then compose a scope helper rather
than trusting that each report already remembered. Worth its own PR, sequenced
ahead of phase 1. It is also the kind of change with an exact test: every
report must produce identical numbers before and after.

### 9.2 Simpler alternatives, and why they lose

| Alternative | Why not |
|---|---|
| **Keep text-to-SQL, add more guards** | Guards catch *dangerous* queries. They cannot catch a *wrong* one — a query missing the CANCELLED filter is perfectly safe and perfectly incorrect. No amount of guarding reaches the actual risk. |
| **Text-to-SQL over a curated set of views** | Better — views could bake in rule 33. But it moves holt's accounting semantics into SQL views that duplicate `lib/reports/`, creating a second source of truth that will drift. The drift is invisible until two numbers disagree. |
| **No LLM: a search box over the reports** | Genuinely good, and **should exist regardless** — most of what people ask is "which report shows me X", which is a routing problem a search box solves with no model, no tokens, and no failure mode. Recommend building it; it is a day of work and reduces assistant load. It does not cover parameter extraction ("…for the Danbury store, last quarter"), which is the part an LLM is actually good at. |
| **Buy it** (Metabase/Looker-style embedded BI) | Solves the general case, but cannot know rule 33 either, and adds a dependency plus a second auth model to a product whose selling point is that it runs from one clone. |

The catalog design is the smallest thing that answers parameterised questions
correctly. Combined with §9.1 it is also *simpler than what exists today*,
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
