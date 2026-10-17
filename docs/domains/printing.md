# Printing & Labels

Receipt + invoice rendering and ZPL label printing to network thermal printers. The print *surface* is split between server-rendered HTML pages (browser-driven print dialog) and direct TCP-to-printer ZPL emission.

## Two print paths

| Path | Use case | Driver |
|---|---|---|
| **HTML print page** | Receipts (80mm thermal), invoices (letter), proposals | Browser print dialog — `app/print/receipt/[id]/`, `app/print/invoice/[id]/` |
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

Every label renders through `lib/labels/renderTemplate.ts` (Mustache). Templates are `LabelTemplate` rows, and each has a `context`; `LABEL_FIELDS` there lists, once, the fields each context may use:

| Context | Fields | Rendered by |
|---|---|---|
| PRODUCT | name, sku, vendor, barcode (first UPC, else the product number), width, depth, height, baseCost, baseRetail | `renderLabel` in `lib/labelPrinter.ts` |
| LOCATION | locationCode, locationName, path, store, barcode (`L-<placeId>`) | `lib/labels/placeLabel.ts` |
| BOX | name, sku, box, of, barcode (`B-<productId>-<box>-<of>`), poNumber | `lib/labels/boxLabel.ts` |

A value is escaped for ZPL: `^` and `~` start ZPL commands, so they are replaced with a space. A product named "50^ off" would otherwise end its field and run the rest as a command. Test: `labelRender.test.ts`.

Place and box labels choose their template and printer with `routeContextLabel(context, storeName)`: the first template of that context, and a printer at that store loaded with its tag size. A store with no such printer gets `LabelSetupError` naming what to set up, never another store's printer (it fell back to the first printer anywhere until 2026-10-16, so a warehouse place's label came out at a showroom). Test: `labelRouting.integration.test.ts`. `printZpl(printerId, zpl)` sends to the stored address of a printer chosen by id, never an address from the request.

## API surfaces

| Endpoint | Purpose | Rate limit |
|---|---|---|
| `GET /api/printers/list` | List configured printers | none |
| `POST /api/printers/create`, `[id]/*` | Admin CRUD on printer rows | ADMIN-gated |
| `GET /api/labels` | List label templates | — |
| `POST /api/print-label/batch` | Print N labels in one call | **10 req/min**, max 50 items, 10 copies per item |
| `POST /api/print-label/*` (single) | Print one label | **30 req/min** |
| `POST /api/print/order/*` | Generate receipt/invoice print HTML | 30 req/min |
| `POST /api/warehouse/stock-locations/[id]/label` | A place's label (`{ copies }`), from Warehouse › Locations | `inventory.locations.manage` or `warehouse.operate` |
| `POST /api/scan/box-labels` | A PO line's box labels, printed before a multi-box product is received | `purchasing.receive` or `warehouse.operate` |

Auth: `roles: ["ADMIN", "MANAGER", "REGISTER", "WAREHOUSE"]` on user-facing endpoints. ADMIN-only for printer-config CRUD.

### Batch caps

The batch endpoint caps at 50 items and 10 copies per item (max 500 labels per call). Beyond that, the operator should slice the work into multiple batch calls. The cap prevents accidentally queuing the entire catalog when a filter glitches.

## HTML print pages

`app/print/receipt/[id]/ReceiptPrintView.tsx` (80mm thermal, 203 DPI; pinned against source 2026-10-17):

- Draws the whole receipt on a canvas 640px wide (80mm at 203 DPI) and prints it as an image, so a
  thermal head gets crisp pixels rather than antialiased text.
- The printed page is 80mm wide and exactly as long as the receipt: `lib/receiptPage.ts`
  `receiptPageRule` builds `@page { size: 80mm <length>mm }` from the canvas height. Until 2026-10-17
  it asked for `size: 80mm auto`, which is invalid (`size` takes one or two lengths, never a length
  and `auto`), so the browser dropped it and the unscoped landscape-Letter `@page` in
  `styles/globals.css` won: "Save as PDF" produced an 11x8.5in page.
- Header: store name, address, and `AppSettings.tagline`; footer: a thank-you line, then the store's own
  `AppSettings.receiptFooter` (its returns or warranty note, set in Admin -> Settings, word-wrapped to the
  paper by `lib/receiptPage.ts` `wrapText`). Unset prints nothing; it was a hardcoded "Returns within 7 days
  with receipt." for every deployment until 2026-10-17. The invoice prints the same note in its footer.
- Total cross-checked against sum-of-lines + tax + payments [NEEDS VERIFICATION].

`app/print/invoice/[id]/InvoicePrintView.tsx` (letter, `@page { size: letter; margin: 0.75in }`):

- Full-page layout with header (the company brand), line table, totals, payment summary
- Email-friendly: also rendered to PDF via the proposal-PDF infrastructure when sent rather than
  printed [NEEDS VERIFICATION]

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
| Template rendering | `labelRender.test.ts`: each context's fields, ZPL escaping |
| Batch endpoint caps | None |
| Receipt total cross-check | None — should be a real-DB integration |

## Known gaps

- No auto-print on order confirmation (master plan G3 / Phase 1)
- No print-job audit log — fire-and-forget means we can't replay failed prints
- No printer-down monitor — failures only surface when an operator tries to print
- ZPL preview (render-to-PNG locally before sending) would help template authoring

---
Last verified: 2026-05-20
