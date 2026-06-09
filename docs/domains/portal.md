# Customer Portal

Token-gated, no-login customer-facing surfaces. Customers receive a link via email or text and can view their order balance, pay via Stripe, or submit a return request — all without logging in. The link expires after 7 days.

## Scope

| Surface | UI | API |
|---|---|---|
| Order detail (balance + pay button + status) | `pages/portal/order.tsx` | `GET /api/portal/order?token=...` |
| Stripe pay flow | (same page) | `POST /api/portal/pay` |
| Return request | `pages/portal/return/*` | `pages/api/portal/returns/*` |
| Generate link (admin / SMS / email) | — | `POST /api/portal/generate-link` |

## Token format

`lib/portalToken.ts` — JWT signed with `NEXTAUTH_SECRET`:

```ts
{ orderId: number, customerId: number, exp: <7 days> }
```

- **Generation**: `generatePortalToken(orderId, customerId)` returns a signed JWT
- **Verification**: `verifyPortalToken(token)` returns the payload OR `null` (never throws — caller must null-check)
- **Expiry**: 7 days hard-coded. If you need to extend a stale link, regenerate; don't lengthen.

The token payload is **NOT a session** — it's a per-order scope. A token for order 123 cannot read order 124 even if the customer owns both. Each order link is independent.

## Auth boundary

Every portal endpoint MUST:

1. Call `verifyPortalToken(token)` and reject (`401`) on null return
2. Cross-check the payload's `orderId` matches the requested order
3. Apply `rateLimit()` from `lib/rateLimit.ts` (portal endpoints are explicitly rate-limited — see `apps/src/lib/rateLimit.ts` config)
4. Never echo `customerId` or other PII fields the client didn't already implicitly have access to (the token gives them order-scope, not customer-scope)

**Rate limit**: portal routes are stricter than authenticated routes — they're public to anyone with the link, so brute-force or token-fishing must be slow.

## Stripe pay flow

`POST /api/portal/pay`:

1. Verify token → resolve `orderId` + `customerId`
2. Compute current balance via `paymentService.computeBalance(orderId)` (per `docs/domains/pos.md`)
3. Reject if balance ≤ 0 (nothing to pay)
4. Create a Stripe Checkout Session via `lib/stripe.ts` with `success_url` + `cancel_url` pointing back at `/portal/order?token=...`
5. Return the session URL to the client; client redirects to Stripe

**Webhook idempotency** (verified against `pages/api/stripe/webhook.ts` on 2026-05-20):

- The webhook handler verifies the Stripe signature via `stripe.webhooks.constructEvent`.
- On `checkout.session.completed`, it searches for a Payment row where `processorTxnId = session.id AND status = "PENDING"`.
- First delivery: finds the PENDING row → updates to `COMPLETED`.
- Second+ deliveries: finds no PENDING row (the first delivery already moved status to COMPLETED) → silently no-op.

So idempotency is enforced by the **status filter**, NOT by a unique index. `Payment.processorTxnId` is `String?` with no `@unique` constraint on the schema today. That means:

- Sequential duplicate webhooks are handled correctly (the status check protects us).
- Truly concurrent deliveries (rare but possible) could theoretically race the status check + update. The window is small.
- Adding `@unique` on `processorTxnId` would tighten this, but requires confirming no legitimate Payment rows currently share a null/repeated processorTxnId.

Tracked as a master-plan checklist item (C8 in `~/.claude/plans/check-the-repo-familiarize-lovely-leaf.md`).

## Return request flow

`pages/portal/return/[token]/*` — customer fills out a return reason, attaches photo, submits. Creates a `Return` row in `INITIATED` status (per `docs/domains/returns.md`). Notifies the warehouse via the dispatch board.

The customer cannot approve, inspect, or process the refund — those are staff-only state transitions handled in `/api/returns/[id]/*`.

## Link generation paths

`POST /api/portal/generate-link` accepts `{ orderId }`, returns `{ url, expiresAt }`. Gated `roles: ["ADMIN", "MANAGER", "REGISTER"]`. The URL embeds the token as `?token=<jwt>`.

Used by:

- Order detail page → "Send Payment Link" button (manager/register)
- Outbound SMS template (manual paste for now; future automation per ROADMAP)
- Email follow-up templates

## Verification checklist (before touching portal code)

- [ ] Token verification on every endpoint — `verifyPortalToken(token)` MUST be the first non-trivial line
- [ ] Cross-check `payload.orderId === req.body.orderId` (or URL param)
- [ ] `rateLimit()` applied
- [ ] No PII leaks beyond the order's scope
- [ ] If touching expiry, confirm the new TTL is documented here

## Test coverage

| Surface | Coverage |
|---|---|
| `portalToken.ts` (generate + verify round-trip + tamper rejection) | Unit tests TBD — **gap** |
| Stripe pay flow | None — should add tripwire for verifyToken + rateLimit being called in sequence |
| Return request | None |

## Known gaps

- No automated SMS dispatch of the portal link (manual paste for now)
- No "you have an open balance" reminder cron — would help collections
- Token revocation is implicit (expire-only); no way to invalidate a leaked token before its 7-day TTL

---
Last verified: 2026-05-20
