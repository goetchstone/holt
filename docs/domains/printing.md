# Printing & Labels

Receipt + invoice rendering and ZPL label printing to network thermal printers. The print *surface* is split between server-rendered HTML pages (browser-driven print dialog) and direct TCP-to-printer ZPL emission.

## Two print paths

| Path | Use case | Driver |
|---|---|---|
| **HTML print page** | Receipts (80mm thermal), invoices (letter), proposals | Browser print dialog — `pages/print/receipt/[id].tsx`, `pages/print/invoice/[id].tsx` |
| **Direct ZPL** | Product labels, shelf tags, pick tickets | TCP socket to printer IP:9100 — `lib/labelPrinter.ts` |

The browser-driven path is operator-controlled (they hit Cmd-P, choose printer). The ZPL path is server-side fire-and-forget — operator clicks a button, label spits out.

## ZPL emission — `lib/labelPrinter.ts`

Network protocol is raw TCP to port 9100 (Zebra standard). No drivers, no spoolers — we open a socket, send ZPL bytes, close.

### Connection behavior

| Constant | Value | Notes |
|---|---|---|
| `CONNECT_TIMEOUT_MS` | 5000 | 5s to establish — printers on the local LAN should answer in ms |
| `RETRY_DELAY_MS` | 2000 | 2s pause before single retry on transient error |
| `RETRYABLE_CODES` | `ECONNREFUSED`, `ETIMEDOUT`, `ECONNRESET`, `EHOSTUNREACH` | Retried once, then surface a human-readable error |

Human-readable errors include the printer IP and actionable guidance ("Check that it is powered on and connected to the network").

### Template rendering

Templates use Mustache (`Mustache.render`) — simpler than Handlebars for the per-label substitution we do. Template stored as a `LabelTemplate` row keyed by name (`product-label`, `shelf-tag`, `pick-ticket`, etc.). Field substitution: product name, part number, barcode, price, store.

## API surfaces

| Endpoint | Purpose | Rate limit |
|---|---|---|
| `GET /api/printers/list` | List configured printers | none |
| `POST /api/printers/create`, `[id]/*` | Admin CRUD on printer rows | ADMIN-gated |
| `GET /api/labels` | List label templates | — |
| `POST /api/print-label/batch` | Print N labels in one call | **10 req/min**, max 50 items, 10 copies per item |
| `POST /api/print-label/*` (single) | Print one label | **30 req/min** |
| `POST /api/print/order/*` | Generate receipt/invoice print HTML | 30 req/min |

Auth: `roles: ["ADMIN", "MANAGER", "REGISTER", "WAREHOUSE"]` on user-facing endpoints. ADMIN-only for printer-config CRUD.

### Batch caps

The batch endpoint caps at 50 items and 10 copies per item (max 500 labels per call). Beyond that, the operator should slice the work into multiple batch calls. The cap prevents accidentally queuing the entire catalog when a filter glitches.

## HTML print pages

`pages/print/receipt/[id].tsx` (80mm thermal, 203 DPI):

- Renders the order at a fixed 280px wide layout (203 DPI × 1.6")
- CSS `@media print` strips chrome and shrinks font for the thermal head
- Total cross-checked against sum-of-lines + tax + payments to catch any silent inflation (CLAUDE.md gotcha enforcement)

`pages/print/invoice/[id].tsx` (letter):

- Full-page layout with header (the company brand), line table, totals, payment summary
- Email-friendly: also rendered to PDF via the proposal-PDF infrastructure when sent rather than printed

## Printer admin

`pages/admin/setup/printers.tsx` — list, add, edit, delete `Printer` rows. Per printer: name, ipAddress, port (default 9100), store assignment, default template.

Add a printer: store IP, ping-test from the admin UI, save. The ping test does a real `attemptSend()` with a no-op ZPL so it surfaces connection errors immediately rather than waiting for a real print to fail.

## Verification checklist (before touching print code)

- [ ] If touching `labelPrinter.ts`, the retry behavior (ECONNREFUSED → wait 2s → retry once → fail with IP-in-message error) must be preserved
- [ ] If touching the batch endpoint, the 50-item × 10-copy caps stay in place
- [ ] If touching receipt total math, the cross-check against line-sum + tax + payments stays in place
- [ ] Rate limits applied (30/min single, 10/min batch)

## Test coverage

| Surface | Coverage |
|---|---|
| `labelPrinter.ts` retry logic | Unit tests TBD — **gap**, would mock the `net.Socket` |
| Mustache template rendering | None |
| Batch endpoint caps | None |
| Receipt total cross-check | None — should be a real-DB integration |

## Known gaps

- No auto-print on order confirmation (master plan G3 / Phase 1)
- No print-job audit log — fire-and-forget means we can't replay failed prints
- No printer-down monitor — failures only surface when an operator tries to print
- ZPL preview (render-to-PNG locally before sending) would help template authoring

---
Last verified: 2026-05-20
