# Customer Portal

Token-gated, no-login customer-facing surfaces. Customers receive a link via email or text and can view their order balance, pay via Stripe, or submit a return request — all without logging in. An order link expires after the store's link lifetime: 48 hours unless `AppSettings.portalTokenTtlHours` sets another, from 1 to 168. Only `PUT /api/admin/settings` sets it; no Settings screen has a field for it yet ("Link generation paths" below). A return link is the Return's own `portalToken` and does not expire ("Return request flow" below).

## Scope

| Surface | UI | API |
|---|---|---|
| Order detail (balance + pay button + status) | `app/portal/order/PortalOrderView.tsx` | `GET /api/portal/order?token=...` (totals by `computeBalance`; only lines still owed and payments that settled are listed, a refund as a negative amount; fixed 2026-11-11, `sales-orders.md`) |
| Stripe pay flow | (same page) | `POST /api/portal/pay` |
| Return request | `app/portal/return/*` | `pages/api/portal/returns/*` |
| Order link (order page, text, automatic messages) | — | `POST /api/portal/generate-link`, `POST /api/portal/text-link`, `lib/messages/due.ts`, all through `portalOrderUrl` ("Link generation paths" below) |

## Token format

`lib/portalToken.ts` — a JWT signed through `lib/capabilityToken.ts`, with a key derived from `NEXTAUTH_SECRET` for this family alone (HKDF, audience `holt-portal`):

```ts
{ orderId: number, customerId: number, exp: <48 hours, or the store's lifetime> }
```

- **Generation**: `generatePortalToken(orderId, customerId, ttlHours = 48)` returns a signed JWT. Callers go through `portalOrderUrl` (`lib/portalLink.ts`), which passes the store's lifetime
- **Verification**: `verifyPortalToken(token)` returns the payload OR `null` (never throws — caller must null-check)
- **Expiry**: `DEFAULT_PORTAL_TOKEN_TTL_HOURS` (48, in `lib/portalToken.ts`) unless `AppSettings.portalTokenTtlHours` sets another. `getAppSettings` reads a stored value outside 1 to 168 as unset. If you need to extend a stale link, regenerate; don't lengthen.

The token payload is **NOT a session** — it's a per-order scope. A token for order 123 cannot read order 124 even if the customer owns both. Each order link is independent.

## Auth boundary

Every order-portal endpoint MUST (the return routes are the exception: their capability is the Return's `portalToken`, a row lookup, "Return request flow" below):

1. Call `verifyPortalToken(token)` and reject (`401`) on null return
2. Cross-check the payload's `orderId` matches the requested order
3. Apply `rateLimit(config, "<route-name>")` from `lib/rateLimit.ts`, with a bucket name of its own (portal endpoints are explicitly rate-limited). The count is kept in Postgres (`RateLimitWindow`), so it holds across every app process.
4. Never echo `customerId` or other PII fields the client didn't already implicitly have access to (the token gives them order-scope, not customer-scope)

**Rate limit**: portal routes are stricter than authenticated routes — they're public to anyone with the link, so brute-force or token-fishing must be slow.

## Stripe pay flow

`POST /api/portal/pay`:

1. Verify token → resolve `orderId`
2. Compute current balance via `paymentService.calculateOrderBalance(orderId)` (per `docs/domains/pos.md`)
3. Reject if balance ≤ 0 (nothing to pay); the payment is the requested `amount` capped at the balance, or the whole balance
4. Start the checkout through `paymentService.startHostedCheckout` (on the active provider) with `success_url` + `cancel_url` pointing back at `/portal/order?token=...`. While a checkout on the order is still open (PENDING, under 24h) it answers 409 with the amount and age; `force: true` voids that one and starts a new one, which is safe because the token scopes it to the customer's own order. `PortalOrderView` turns that 409 into a confirm in plain words (`lib/openCheckoutPrompt.ts`) and re-posts with `force` on yes; on no it shows nothing. The PENDING row is labelled "Card" whether or not the payment is partial
5. Return the session URL to the client; client redirects to the processor

**Webhook idempotency** (verified against `pages/api/stripe/webhook.ts` on 2026-05-20):

- The webhook handler verifies the Stripe signature via `stripe.webhooks.constructEvent`.
- On `checkout.session.completed`, it searches for a Payment row where `processorTxnId = session.id AND status = "PENDING"`.
- First delivery: finds the PENDING row → updates to `COMPLETED`.
- Second+ deliveries: finds no PENDING row (the first delivery already moved status to COMPLETED) → silently no-op.

So idempotency is enforced by the **status filter**, NOT by a unique index. `Payment.processorTxnId` is `String?` with no `@unique` constraint on the schema today. That means:

- Sequential duplicate webhooks are handled correctly (the status check protects us).
- Truly concurrent deliveries (rare but possible) could theoretically race the status check + update. The window is small.
- Adding `@unique` on `processorTxnId` would tighten this, but requires confirming no legitimate Payment rows currently share a null/repeated processorTxnId.

Tracked as a master-plan checklist item (C8); the plan is not kept in the repo.

## Return request flow

Staff mint the link: `POST /api/sales/orders/[id]/return-link` (`sales.write`) creates the `Return` in `INITIATED` with a random `portalToken` (a UUID on the row, not a JWT, so it does not expire) and `portalRequestedAt`, and answers with `/portal/return/<portalToken>`. The customer's page (`app/portal/return/[token]/*`) reads `GET /api/portal/returns/[token]` and posts a reason and notes to `POST /api/portal/returns/request`. It attaches no photo and notifies nobody; the return waits in the staff returns list (`docs/domains/returns.md`). `app/portal/return/status/[token]/*` shows its progress from the same GET.

The request route is public, so it trusts nothing in the body (fixed 2026-11-21):

- **The body is checked first** (`parsePortalReturnRequest` in `lib/returns/portalReturn.ts`). The reason must be a `ReturnReason`; an unknown one is a 400 naming the reasons (it reached the enum column and was a 500). Notes must be text, and a `lineItemId` a whole number above zero.
- **A named line must be one the return may be for** (`returnLineProblem` in `lib/returns/returnLine.ts`): on the return's own order, still counted (not cancelled or replaced, quantity above zero: rules 31 and 33, through `isCountedItemLine`), and goods (not a gift card or the order's delivery fee). Anything else is a 400: one message for a line not on the order, one naming the other reasons. It used to write any line id it was sent, so a token holder could point their return at another customer's line, and a return is valued from its line when it is paid out (`lib/returns/bookReturn.ts`). The staff return-link endpoint checks a line it is given with the same function. The page itself never sends a line.
- **The answer is what the pages read**, `PortalReturn` (`lib/returns/portalReturnContract.ts`: return number, status, product name, quantity, created, customer notes), the same projection as the GET, which both pages import. Neither page reads the reason, so it is stored and not sent back. It used to be the whole `Return` row: the order and customer ids, the line, the token and every staff field.
- Unchanged: 404 for an unknown token, 409 once the return has left `INITIATED` or when the link was never activated, rate-limited 10/min.

The customer cannot approve, inspect, or process the refund — those are staff-only state transitions handled in `/api/returns/[id]/*`.

## Link generation paths

Every order link is built by `portalOrderUrl(orderId, customerId, ttlHours)` in `lib/portalLink.ts`: `<NEXTAUTH_URL>/portal/order?token=<jwt>`, signed for the store's lifetime. It is reached three ways (checked against source 2026-11-21):

- `POST /api/portal/generate-link` takes `{ orderId }` (a number) and answers `{ url, orderno }`: 404 for an unknown order, 400 for one with no customer. Gated `requireAuthWithRole(["DESIGNER", "REGISTER", "MANAGER", "ADMIN"])`. The order page's "Customer Portal (Test Mode)" card calls it from "Generate Portal Link", and that card shows only to MANAGER, ADMIN and SUPER_ADMIN.
- "Text the link" on the same card (`POST /api/portal/text-link`, `sales.write`) texts a fresh link. Who may get a text: `sms.md`
- Each automatic customer message (`lib/messages/due.ts`) carries a fresh link when its email or its text is set to include the order link.

**No Settings screen sets the lifetime.** `PUT /api/admin/settings` (`admin.settings`) is the only way in: `portalTokenTtlHours` is a whole number of hours from 1 to 168, or null for the 48-hour default. No component reads or writes it, though the order page's card says a link "expires after the time set in Settings".

## Verification checklist (before touching portal code)

- [ ] Token verification on every endpoint — `verifyPortalToken(token)` MUST be the first non-trivial line
- [ ] Cross-check `payload.orderId === req.body.orderId` (or URL param)
- [ ] `rateLimit()` applied
- [ ] No PII leaks beyond the order's scope
- [ ] If touching expiry, confirm the new TTL is documented here

## Test coverage

| Surface | Coverage |
|---|---|
| `portalToken.ts` (generate + verify round-trip + tamper rejection) | `__tests__/capabilityToken.test.ts`, `__tests__/fuzz/capabilityTokens.fuzz.test.ts` |
| Stripe pay flow | None — should add tripwire for verifyToken + rateLimit being called in sequence |
| Return request | `__tests__/portalReturnRequest.test.ts` (the body and the projection); `__tests__/integration/portalReturnRequest.integration.test.ts` (the line rule on both routes, the reason, the projection, the refusals) |

## Known gaps

- No "you have an open balance" reminder cron — would help collections
- Token revocation is implicit (expire-only); no way to invalidate a leaked order link before it expires

---
Last verified: 2026-05-20
