# AI Assistant — where the work lives

The AI assistant feature spans several branches, and **none of it is on `main`
yet**. This file is the only thing about it that is, and it exists solely so
nobody has to already know where to look.

**Ownership is split across branches — check who authored one before rebasing
or force-pushing it.** The lineage below is verified: each branch contains the
one above it.

## The branches

- **Prototype (superseded):** `ai-chatbot` (@ `8d99c61`) — the text-to-SQL PoC.
  Reuse its ChatPanel, the `/app/assistant` page, and the `ai` module entry;
  drop the SQL path.
- **Authoritative design + hardening:** `feat/ai-chatbot-guardrails` — branched
  off the prototype; adds the credentials fix, the design document, and the
  "supersede the guard, don't harden it" finding. Source of truth for the
  architecture.
- **Provider routing seam:** `feat/ai-provider-seam` — built on the design
  branch; the §5 `route()` seam plus the local (openai-compatible / Ollama)
  provider.
- **Review + coordination log:** `docs/ai-assistant-review` — the branch index
  and ownership record.

```sh
# Authoritative design — architecture, security findings, phasing
git show feat/ai-chatbot-guardrails:docs/ai-assistant-design.md

# Index, review, sign-off and the coordination log between agents
git show docs/ai-assistant-review:docs/ai-assistant-review.md

# See every AI branch
git branch -a | grep -E 'ai-chatbot|ai-assistant|ai-provider'
```

Start with the **coordination log** — it opens with a "Where everything lives"
index. The design document is the reference.

## Three things that change what gets built

Read the design before writing code. Each of these overturned an earlier draft,
and two were errors in the design document's *own* first version — which is why
they are repeated here rather than left to be rediscovered.

1. **Text-to-SQL is rejected, not hardened.** The guard on
   `feat/ai-chatbot-guardrails` has fourteen verified bypasses, including staff
   password hashes (`passwordHash` is on `StaffMember`, not `User`) and
   `IntegrationCredential` via `query_to_xml` — where the literal-stripping that
   stops a customer named `'Session'` breaking the assistant *is* the bypass.
   `__tests__/aiSqlGuard.test.ts` asserts those holes deliberately, so the file
   documents why the path is being deleted rather than patched.

2. **A catalog entry may not call `lib/reports/*` directly.** Four report
   modules state in their own headers that authorization stays in the tRPC
   procedure — `reports.ts` keeps non-managers to their own staff record in the
   *procedure body*. Wrapping the lib function hands any salesperson any
   colleague's numbers. Entries go through caller-scoped wrappers, with an
   import tripwire.

3. **The per-report permission substrate does not exist.** `reports.ts` has 40
   role gates and **zero** `permissionProcedure`, and the catalog defines only
   two reporting permissions. Mapping entries to `reporting.read` — held by
   DESIGNER — reaches ADMIN-only reports and `dormantCustomers`' email-and-phone
   list. Copy each report's existing role set instead of inventing permissions.

## When these branches merge

Delete this file in the same PR that lands the design on `main`. A breadcrumb
pointing at branches that no longer exist is worse than none.
