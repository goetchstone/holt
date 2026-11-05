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
| PRODUCT (price tag) | name, sku, vendor, barcode (first UPC, else the product number), width, depth, height, baseRetail, costCode, baseCost, photo | `renderProductTag` in `lib/labels/productTag.ts` |
| SALE (sale tag) | as PRODUCT, plus wasPrice, saving, savingPercent | `renderProductTag` |
| LAW (law tag) | name, sku, vendor, barcode, width, depth, height, lawText | `renderProductTag` |
| SOLD (sold tag) | name, sku, vendor, quantity, orderNumber, customer, customerLastName, soldOn, salesperson | `lib/labels/soldTag.ts` |
| LOCATION | locationCode, locationName, path, store, barcode (`L-<placeId>`) | `lib/labels/placeLabel.ts` |
| BOX | name, sku, box, of, barcode (`B-<productId>-<box>-<of>`), poNumber | `lib/labels/boxLabel.ts` |

A value is escaped for ZPL: `^` and `~` start ZPL commands, so they are replaced with a space. A product named "50^ off" would otherwise end its field and run the rest as a command. Test: `labelRender.test.ts`.

Place and box labels choose their template and printer with `routeContextLabel(context, storeName)`: the first template of that context, and a printer at that store loaded with its tag size. A store with no such printer gets `LabelSetupError` naming what to set up, never another store's printer (it fell back to the first printer anywhere until 2026-10-16, so a warehouse place's label came out at a showroom). Test: `labelRouting.integration.test.ts`. `printZpl(printerId, zpl)` sends to the stored address of a printer chosen by id, never an address from the request.

### Tags (GAP-18, DECISIONS 43)

- **Coded cost.** `AppSettings.costCipherKey`, ten different letters set in Settings: the first stands for 1, the ninth for 9 and the tenth for 0 (`lib/labels/costCode.ts`). `costCode` is the landed cost, else the catalog cost, in whole dollars. With no key it prints nothing, never the real number. `baseCost` is the real number and stays for back-of-house labels, so the template screen says which is which.
- **Photo.** A template with `photoDots` (the longest side, in dots) gets a `photo` field, placed with `^FO30,30{{photo}}^FS`. `lib/labels/photo.ts` shrinks the picture, never enlarges it, dithers it to one bit and writes a `^GFA` graphic field. Only a picture Holt holds (`/uploads/...`) is read, and a picture at another address isn't fetched. With no picture, or one that can't be read, the field is empty and the tag still prints. That includes HEIC, which the upload accepts and `sharp`'s standard build doesn't read.
- **Sale tag.** Its price is `baseRetail`, what the register charges, so a tag and a sale can't disagree. `Product.wasPrice` is the price it started at, set on the product's page. It's refused without a was price above retail. Holt has no scheduled sale prices yet (GAP-06), so a markdown is a change to retail plus a was price.
- **Law tag.** What it has to say depends on where the store is, so the wording is the store's template (rule 61), and `Product.lawTagText` is the product's own part. It's refused without that text. Holt doesn't know the law in a store's state: the demo's template is a sample.
- **Sold tag.** `POST /api/sales/orders/[id]/sold-tag`, from a line on the order page. Only for a line of an ORDER or FULFILLED order that's still on it with a quantity (rules 31, 33). It prints no price or cost. `customerLastName` is there for a tag on a showroom floor.
- **One at a time or all at once.** While receiving, one at a time gives each line a "Print tag" button that prints one tag per press, before the receipt saves, so each comes out as its piece is matched. All at once is the checkbox and the batch after saving. The choice is `StaffMember.tagPrintMode`, remembered per person (`account.setTagPrintMode`), and it's one at a time until they choose (owner, 2026-10-29). The handheld's Receive screen has a Tag button on each line.
- **Which printer.** Given a store, only that store's printers. `resolveRoute` used to take the first printer loaded with the size, anywhere, so a tag could come out in another building. It now refuses and names what's missing, as `routeContextLabel` does. Receiving passes its store.

## API surfaces

| Endpoint | Purpose | Rate limit |
|---|---|---|
| `GET /api/printers/list` | List configured printers | none |
| `POST /api/printers/create`, `[id]/*` | Admin CRUD on printer rows | ADMIN-gated |
| `GET /api/labels` | List label templates | — |
| `POST /api/print-label/batch` | Print N price tags in one call (`storeLocationId` keeps them to that store's printers) | **10 req/min**, max 50 items, 10 copies per item; `purchasing.receive` or `warehouse.operate` |
| `POST /api/print-label` | Print one product's tag (`kind`, `storeLocationId`, `copies` up to 10), or a named template on a named printer. Answers with what it did, never the rendered label, which can carry the real cost | **30 req/min**; `purchasing.receive` or `warehouse.operate` |
| `POST /api/sales/orders/[id]/sold-tag` | A line's sold tag | `sales.write` or `warehouse.operate` |
| `POST /api/print/order/*` | Generate receipt/invoice print HTML | 30 req/min |
| `POST /api/warehouse/stock-locations/[id]/label` | A place's label (`{ copies }`), from Warehouse › Locations | `inventory.locations.manage` or `warehouse.operate` |
| `POST /api/scan/box-labels` | A PO line's box labels, printed before a multi-box product is received | `purchasing.receive` or `warehouse.operate` |

ADMIN-only for printer-config CRUD.

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
- The order's own disclaimers (GAP-07, sales-orders.md "Invoice tools") print between the payments and
  the footer, wrapped by the same `wrapText` and counted into the canvas height before it is sized
  (`drawDisclaimers`).

`app/print/invoice/[id]/InvoicePrintView.tsx` (letter, `@page { size: letter; margin: 0.75in }`):

- Full-page layout with header (the company brand), line table, totals, payment summary
- **Pictures (GAP-07, 2026-11-03).** A picture column appears when any line has one:
  `lib/sales/linePicture.ts` `linePictureUrl` takes the line's product's `imageUrl`, else the vendor
  style's on the line, else the one on its product. A product's picture is uploaded on its page
  (`POST`/`DELETE /api/products/[id]/picture`, `catalog.write`, the `IMAGE` upload preset, saved
  under `data/uploads/images/products/`). Removing or replacing one deletes no file: an extracted line
  drawing is its style's too, and a custom product configured from it copied its `imageUrl`
  (`create-from-cart`, which copies the picture and not the style link, since editing a style
  rewrites the name and retail of every product linked to it). A picture whose file is gone prints
  nothing rather than a broken box.
- **It prints once the pictures are in.** The page used to call `print()` 500ms after the order
  loaded, which could print before the pictures arrived. It now waits for every image to load or
  fail, for up to 3 seconds (`picturesLoaded`).
- **Line notes** print under their line, and the order's **disclaimers** above the footer, each as it
  read when it was added (sales-orders.md "Invoice tools").
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
| Print payload: line notes, pictures, disclaimers | `invoiceTools.integration.test.ts` (the route); the picture order in `invoiceToolsShared.test.ts` |

## Known gaps

- No auto-print on order confirmation (master plan G3 / Phase 1)
- No print-job audit log — fire-and-forget means we can't replay failed prints
- No printer-down monitor — failures only surface when an operator tries to print
- ZPL preview (render-to-PNG locally before sending) would help template authoring

---
Last verified: 2026-05-20
