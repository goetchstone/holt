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
- **Sale tag.** Its price is what the register charges today, so a tag and a sale can't disagree. During a scheduled sale (GAP-06 part B, DECISIONS 60; `lib/pricing/salePrice.ts`) that is the sale price, and the was price is the product's regular retail, with `saleEnds` the sale's last day in the store's locale ("Nov 30, 2026", `saleDayText`). With no sale on, the was price is `Product.wasPrice`, set on the product's page, as a markdown. It's refused without a was price above the price (`saleTagFields` in `lib/labels/productTag.ts`). `saleEnds` is in `LABEL_FIELDS.SALE` and is blank outside a scheduled sale.
- **Price tag during a sale.** A PRODUCT tag's `baseRetail` field is the price the register charges today, so during a sale it prints the sale price too (DECISIONS 43). The tag is decided on the store's day when it prints, so a tag printed the day before a sale starts shows the regular price.
- **Tags to change.** Inventory › Sales lists the products whose tag changes today (`GET /api/pricing/sales/tags-to-change`): SALE tags for sales starting today, PRODUCT tags for sales that ended yesterday or were ended early since. "Print all" sends them through the batch route with that `kind` and the chosen store, in requests of 50 (`lib/labels/batchPrintShared.ts` `inBatches`), and lists any tag that didn't print with its reason. Nothing prints them on a schedule.
- **Law tag.** What it has to say depends on where the store is, so the wording is the store's template (rule 61), and `Product.lawTagText` is the product's own part. It's refused without that text. Holt doesn't know the law in a store's state: the demo's template is a sample.
- **Sold tag.** `POST /api/sales/orders/[id]/sold-tag`, from a line on the order page. Only for a line of an ORDER or FULFILLED order that's still on it with a quantity (rules 31, 33). It prints no price or cost. `customerLastName` is there for a tag on a showroom floor.
- **One at a time or all at once.** While receiving, one at a time gives each line a "Print tag" button that prints one tag per press, before the receipt saves, so each comes out as its piece is matched. All at once is the checkbox and the batch after saving. The choice is `StaffMember.tagPrintMode`, remembered per person (`account.setTagPrintMode`), and it's one at a time until they choose (owner, 2026-10-29). The handheld's Receive screen has a Tag button on each line.
- **How many tags all at once prints.** `receivedTagCopies` in `lib/labels/tagCopies.ts`. A whole-number quantity is a count of pieces: one tag each, at most `MAX_TAG_COPIES` per line, as the batch route clamped them before #127. A fractional quantity can only be a length, a part roll of fabric or wallpaper, which receiving keeps as its length and never truncates (`lib/inventory/qtyInput.ts`): it is one item, so it gets one tag, and nothing is left to print for it. When a count leaves pieces without a tag, the screen names each such line and how many are still to print, from the product's page (`receivedTagsShortNote`). From #127 until 2026-11-21 the screen asked for the quantity received itself, which the bound refuses, so a line of more than ten, or a part roll, printed none of its tags. Two owner questions are open: whether to print one per piece in several prints of at most ten, and whether a whole-number length should get one tag too. Nothing records a unit, so a 30-yard bolt reads as 30 pieces: ten tags and a note asking for twenty more.
- **How all at once sends them.** `printReceivedTags` in `lib/labels/receivedTagPrint.ts` (since 2026-11-21): requests of at most 50 lines (`inBatches`, the batch route's item limit), in the receipt's order, one at a time. Before, the screen sent every tagged line in one request, and the route refuses more than 50 whole, so a receipt of more than 50 tagged lines printed no tags. A refused request stops the run, as "Print all" does: what printed before it stays printed. `receivedTagsReport` says what didn't print, batch by batch: each failed line by name, a refused request with the lines it carried ("The tags for Sofa through Lamp did not print: ..."), and the lines not sent after it. A receipt of one request gets the route's refusal as it is.
- **Which printer.** Given a store, only that store's printers. `resolveRoute` used to take the first printer loaded with the size, anywhere, so a tag could come out in another building. It now refuses and names what's missing, as `routeContextLabel` does. Receiving passes its store.

## API surfaces

| Endpoint | Purpose | Rate limit |
|---|---|---|
| `GET /api/printers/list` | List configured printers | none |
| `POST /api/printers/create`, `[id]/*` | Admin CRUD on printer rows | ADMIN-gated |
| `GET /api/labels` | List label templates | — |
| `POST /api/print-label/batch` | Print N price tags in one call (`storeLocationId` keeps them to that store's printers). An optional `kind` (`PRODUCT`, `SALE` or `LAW`) prints that tag for every item as the single print does (`printProductTag`); without it, auto-route by category as before | **10 req/min**, max 50 items, 10 copies per item; `purchasing.receive` or `warehouse.operate` |
| `POST /api/print-label` | Print one product's tag (`kind`, `storeLocationId`, `copies` up to 10), or a named template on a named printer. Answers with what it did, never the rendered label, which can carry the real cost | **30 req/min**; `purchasing.receive` or `warehouse.operate` |
| `POST /api/sales/orders/[id]/sold-tag` | A line's sold tag | `sales.write` or `warehouse.operate` |
| `POST /api/print/order/*` | Generate receipt/invoice print HTML | 30 req/min |
| `POST /api/warehouse/stock-locations/[id]/label` | A place's label (`{ copies }`), from Warehouse › Locations | `inventory.locations.manage` or `warehouse.operate` |
| `POST /api/scan/box-labels` | A PO line's box labels, printed before a multi-box product is received | `purchasing.receive` or `warehouse.operate` |

ADMIN-only for printer-config CRUD.

### Batch caps

**Copies per tag** are bounded in one place: `MAX_TAG_COPIES` (10) and the pure check `tagCopiesProblem`, both in `lib/labels/tagCopies.ts`, enforced by `validateTagCopies` in `lib/labelPrinter.ts`, which `printProductTag` runs before `zpl.repeat(copies)` and both label routes run up front (rule 42). A value that is not a whole number from 1 to 10 (non-integer, NaN, string, 0, negative, too big) is rejected, never clamped: `print-label` answers 400 with the message, and the batch marks that item failed with the same message. Receiving chooses its copies before it asks (`receivedTagCopies`, above), so the bound stays a refusal everywhere. Test: `__tests__/labelCopies.test.ts`.

The batch endpoint caps at 50 items and 10 copies per item (max 500 labels per call); the item limit lives in `lib/labels/batchPrintShared.ts`, which the route and the screens share, and the copies limit is `MAX_TAG_COPIES` above. Beyond that, a screen slices the work into multiple batch calls (`inBatches`), as the Sales screen's "Print all" and the Receive PO screen's all-at-once print do; at 10 requests a minute, a run of more than 500 items is stopped by the rate limit and the screen says what printed before it. The cap prevents accidentally queuing the entire catalog when a filter glitches.

**What the batch reads from its body**, and the 400s it answers, are `readBatchPrintRequest` in `lib/labels/batchPrintRequest.ts` (since 2026-11-21; the route looks up the store and prints). In order: `items` must be a non-empty array of at most 50, `kind` absent or PRODUCT, SALE or LAW, and `storeLocationId` is a store's id when given. Then each item on its own: no `productId` fails it with "productId is required", and its `copies` (1 when left out) go through `validateTagCopies`. It never throws, so a POST with no body (Next gives `null`) is a 400 "items array is required", and an item that isn't an object fails on its own. Until then both were a 500 that echoed the TypeError, with any item before a null one already printed. It's server only, because `validateTagCopies` lives in `lib/labelPrinter.ts`, which builds the Prisma client; `batchPrintShared.ts`, which the screens import, stays free of it.

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

`app/(dashboard)/app/admin/setup/printers/PrintersView.tsx` (with `components/modals/PrinterModal.tsx`) — list, add, edit, delete `Printer` rows. Per printer (the modal's fields): name, ipAddress, port (default 9100), location, tagType, store, currentSize. There is no default-template field on the printer.

Add a printer: store its IP and save. There is no ping test in the admin UI (checked against `PrintersView.tsx` and `PrinterModal.tsx`, 2026-11-20): a wrong address surfaces on the first real print, as a send error from `labelPrinter.ts` that says to check the network connection and IP address.

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
| Batch endpoint caps and request rules | `batchPrintRequest.test.ts` (50 items taken and 51 refused, each `kind`, `storeLocationId`, a missing `productId` or null item, copies accepted and refused, order, and a property that no JSON body throws); the route in `tags.integration.test.ts` (fourteen copies refused; no body a 400) and `kind` in `scheduledSales.integration.test.ts`; `inBatches` in `scheduledSalesScreen.test.ts` |
| Receiving's tag copies | `labelCopies.test.ts` (`receivedTagCopies`, with a property over every quantity a receipt holds, and `receivedTagsShortNote`); `tags.integration.test.ts` (`receivedTagCopies(14)` prints ten) |
| Receiving's all-at-once print | `receivedTagPrint.test.ts` (120 tagged lines in requests of 50, 50 and 20, in order, against the route's own request reader; each line's copies; a refused request stops the run; each failure and refusal named; the note over the lines that printed) |
| Sale tag during a scheduled sale | `scheduledSales.integration.test.ts` (sale price, regular as was, `saleEnds`; PRODUCT tag at the sale price) and `scheduledSales.test.ts` (`saleTagFields`) |
| Receipt total cross-check | None — should be a real-DB integration |
| Print payload: line notes, pictures, disclaimers | `invoiceTools.integration.test.ts` (the route); the picture order in `invoiceToolsShared.test.ts` |

## Known gaps

- No auto-print on order confirmation (master plan G3 / Phase 1)
- No print-job audit log — fire-and-forget means we can't replay failed prints
- No printer-down monitor — failures only surface when an operator tries to print
- ZPL preview (render-to-PNG locally before sending) would help template authoring

---
Last verified: 2026-05-20; tags during a scheduled sale, batch `kind` and tags to change 2026-11-14; receiving's tag copies and the batch's request rules 2026-11-21 against source.
