# AI Data Chatbot — Feature Plan & Coordination

Status: approved by owner. Implemented on branch `ai-chatbot` (a git worktree) to avoid
colliding with in-flight work on `feat/nav-from-permissions` / `main`.

## Goal
A config-gated AI assistant in the back-office that answers data questions about the
tenant's own database via read-only text-to-SQL. Runs on a local model (ollama, in-house)
or a configured cloud provider (Anthropic / OpenAI). Proven as a standalone PoC; this ports
it into Holt using existing patterns.

## Key facts that shaped the design
- **One deployment = one tenant = one database** (`docs/TENANCY.md`). The chatbot queries
  the deployment's own `@/lib/prisma` client — no routing, and **no MCP server needed** (MCP
  is for exposing tools to *external* AI clients; here they're in-process `lib/` functions).
- **No existing AI runtime** — built from scratch. Node 24 global `fetch` reaches ollama; no
  new SDK needed for the local path.
- The Saybrook data already lives in its own DB (`holt_saybrook`); no restore required.

## Reuse (don't reinvent)
- Feature toggle → add `ai` to `MODULES` in `app/src/lib/modules/registry.ts`; gate with
  `isFeatureEnabled` / `requireModule`.
- Provider selection → mirror `app/src/lib/adapters/index.ts` (`getActiveSourceAdapter()`
  reading `AppSettings`) with `app/src/lib/ai/registry.ts` resolving a provider id.
- Provider keys (phase 3) → `app/src/lib/integrationCatalog.ts` + `resolveCredential`.
- Endpoint → new tRPC router `app/src/server/trpc/routers/chat.ts`, mounted in `_app.ts`,
  `protectedProcedure` + module check. Router→`lib/*` split per `routers/reports.ts`.
- DB → `@/lib/prisma` `$queryRawUnsafe`, behind a SELECT-only guard + statement timeout + row cap.
- UI (phase 2) → a `ChatPanel` in `app/src/components/navigation/AppShell.tsx`.

## File ownership — to avoid collisions with the other agent
**NEW files (owned by branch `ai-chatbot`):**
- `app/src/lib/ai/{types,registry,sql,askData}.ts`
- `app/src/lib/ai/providers/ollama.ts` (anthropic/openai in phase 3)
- `app/src/server/trpc/routers/chat.ts`
- `app/src/components/ai/ChatPanel.tsx` (phase 2)

**SHARED files — small additive edits, coordinate before touching:**
- `app/src/server/trpc/routers/_app.ts` (mount `chatRouter`)
- `app/src/lib/modules/registry.ts` (add the `ai` module entry)
- `app/src/components/navigation/AppShell.tsx` (render the panel — phase 2)
- `app/prisma/schema.prisma` (`AppSettings.aiProviderId` — **phase 3 only**; phase 1 reads
  the provider from an env var so there is NO migration to conflict on)

## Phasing
1. Backend + ollama provider, env-config, no migration. 2. Chat panel. 3. Provider config +
keys + Anthropic/OpenAI. 4. Streaming (dedicated `app/src/app/api/ai/…` route handler).

## Safety
Read-only SQL only (SELECT/CTE guard, forbidden-keyword check, statement timeout, row cap;
prefer a dedicated read-only DB role via `AI_DB_URL`). Cloud providers receive schema +
question only; result rows stay local unless the tenant opts into NL answer synthesis.
