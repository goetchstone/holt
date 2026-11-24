# Architecture

## System Overview

```
                                  Docker Host
                    +-----------------------------------+
                    |                                   |
  iPad/Laptop ---->| Nginx (443) --> Next.js (3000)    |
                    |                 x APP_REPLICAS    |
                    |                    |              |
                    |                    v              |
                    |              PostgreSQL (5433)    |
                    |                                   |
                    +-----------------------------------+
                                    |
              Docker Compose (db, migrate, app, nginx, nginx-host)
```

This is the reference self-hosted topology: a single Docker host running the
Compose services (Postgres, a one-shot migration, the app, nginx, and a
loopback-only nginx for the host's own jobs), no load
balancer, no CDN, no external database. Simplicity is intentional — a single
store can run the whole stack on modest hardware (a NAS is enough). A larger
business runs the app as several processes on the same host behind the same
nginx (`APP_REPLICAS`); sizing, and what is not yet supported, is in
[HOSTING.md](./HOSTING.md). Central hosting runs one such stack per business — the same image,
each with its own database — many isolated deployments rather than one shared
cluster (see docs/TENANCY.md).

## Data Flow: Pricing Import Pipeline

The most complex data path in the system:

```
  Vendor Price List (PDF/CSV/XLSX)
           |
           v
  PDF: POST /api/pricing/parse-pdf  ──>  lib/pricing/parsePriceBook.ts
       (vendor + type required)           registry first: wholesaleProfileFor(vendor)
                                            -> wholesale/columnGrid.ts (one engine,
                                               vendors declare themselves in wholesale/vendors/)
                                          then the legacy per-vendor readers
                                            (wesleyHallParser / gatCreekExtractor / crLaineExtractor / ...)
       400  unknown vendor or unsupported book type -- never a fallback reader
       422  zero rows, or the profile's edition check failed -- `diagnostics` says why
       200  rows + warnings
  CSV/XLSX: [Client] xlsx / papaparse -> vendor row parser
           |
           v
  [Client] Preview in ImportPreviewTable (a refused parse stays on the upload
           step with its diagnostics; Import is disabled at zero rows)
           |
           v
  POST /api/pricing/import/{wholesale-prices|foundations|fabrics|wood-prices}
           |
           v
  [Server] Zod validation
           |
           v
  [Server] Prisma $transaction (up to 300s)
  - Upsert PriceList
  - Upsert VendorPriceDimension + PriceDimensionTier
  - Upsert VendorStyle + Product (linked)
  - Upsert StyleGradePrice / StyleSpeciesPrice / StyleAxisPrice
  - Upsert VendorOptionGroup + VendorOption (from vendor seed config)
  - Upsert StyleOptionOverride (per-style surcharges)
           |
           v
  [Server] Audit log
           |
           v
  200 OK { success, stylesCreated, stylesUpdated, ... }
```

Key design decisions:

- **PDF parsing happens client-side** to avoid shipping large PDFs to the server
- **Vendor-specific parsers** encode institutional knowledge about each vendor's price book format
- **Single transaction** ensures atomicity -- either the entire import succeeds or nothing changes
- **VendorStyle + Product** are created simultaneously. VendorStyle is the catalog template; Product is the materialized item linked via `vendorStyleId`

## Pricing Engine

The `calculatePrice()` and `calculateWoodPrice()` functions in `lib/pricing/priceCalculator.ts` are pure client-side functions with no database dependency. They take pre-loaded product data and user selections, and return a full price breakdown.

### Vendor Pricing Models

| Model | Example | How It Works |
|-------|---------|--------------|
| GRADE_BASED | Upholstery | Cost varies by fabric/leather grade tier |
| FRAME_PLUS_CUSHION | Frames + cushions | Flat base cost + optional surcharges |
| SPECIES_MATRIX | Solid wood | Cost varies by wood species |
| MULTI_AXIS | Custom casegoods | Cost varies by species x width x length |
| FLAT | Stock items | Single price per product |
| AREA_BASED | Window treatments (future) | Cost calculated from dimensions |
| SIZE_BASED | Rugs (future) | Cost varies by size tier |

## Authentication Flow

```
  Browser --> /auth/login --> Google OAuth --> NextAuth callback
                                                   |
                                                   v
                                            JWT session created
                                            (includes user.id, role)
                                                   |
                                                   v
                                            StaffMember auto-linked by email
                                            (fire-and-forget, never blocks login)
```

Roles (`StaffRole`): SUPER_ADMIN, ADMIN, MANAGER, DESIGNER, REGISTER, WAREHOUSE, INSTALLER, MARKETING. SUPER_ADMIN auto-satisfies ADMIN checks; ADMIN bypasses nav permission checks, other roles respect them.

Bootstrap safeguard: if no privileged (ADMIN/SUPER_ADMIN) user with a linked userId exists, role enforcement fails open so the first user can sign in and promote themselves. A warning is logged when this triggers.

## API errors

REST routes answer errors through `lib/apiResponse.ts`: `{ error, code? }`.

- **A refusal the caller can act on is a 4xx with a message for them.** The
  route returns `badRequest` / `notFound` / `conflict` itself, or a library
  throws `ApiError` (status and message), or a typed error that the route
  catches and maps. Examples: `RefundError`, `VoidError`, `DeliveryFeeError`,
  `MoveModeError`, `PlaceError`.
- **Anything else is a fault.** `handleError(res, err, context)` logs it with
  its context (`logError`) and answers `500 { error: "Internal server error",
  code: "INTERNAL_ERROR" }`. The exception's text never reaches the response,
  because it can name Prisma models, columns and constraints, or carry a
  payment processor's own error (CLAUDE.md rule 11). Until 2026-10-30 the
  helper sent `err.message`. Two routes relied on that to show a refusal and
  now catch a typed error instead: voiding a payment that isn't pending, and
  an admin position edit to a place that can't hold stock.
- **tRPC follows the same rule** (`server/trpc/trpc.ts`, since 2026-11-21).
  A procedure refuses by throwing a `TRPCError` with a code and a message for
  the caller, and that message reaches the screen as thrown: `BAD_REQUEST`,
  `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, and an `INTERNAL_SERVER_ERROR` given a
  message of its own. Anything else a procedure throws, @trpc/server 11 wraps
  as `INTERNAL_SERVER_ERROR` whose message is the throw's own; the error
  formatter answers that one with the same `"Internal server error"`
  (`INTERNAL_ERROR_MESSAGE`, `lib/apiResponse.ts`), and the HTTP route's
  `onError` (`app/api/trpc/[trpc]/route.ts`) logs the original with
  `logError`. Until then a Prisma error inside a procedure reached the screen
  as its own text (the invoice composer shows `err.message`). A refusal still
  thrown as a plain `Error` reads as the fixed message too: Stripe not being
  configured, on the invoice's payment link, as the REST checkout routes
  already answered it. `__tests__/trpcErrorBodies.test.ts` drives the route
  with production's `NODE_ENV`; in development tRPC also adds the error's
  stack to the body.
- A route writing its own 500 follows the same rule.
  `__tests__/api500Bodies.test.ts` parses every route under `src/pages/api`
  with the TypeScript parser and refuses a 500 body
  (`.status(S).json/send/end(...)` where S can be 500, so `known ? 409 : 500`
  counts) that reaches an error's message or stack, `getErrorMessage(...)` or
  the caught error itself, directly or through the names it is built from.
  Names are followed to their declarations and every write to them in the same
  file: an assignment to the name or to a property under it
  (`results.error = ...`), `x.push(...)` and its kin, and
  `Object.assign(x, ...)`. The caught error is a catch clause's, or the one a
  promise hands its rejection handler (`.catch((e) => ...)`). Fixtures pin each
  shape. `apiResponse.test.ts` holds `handleError` to it. Until 2026-11-21 the
  tripwire read only the body's own text, and 29 routes put `err.message` into
  a 500 through a variable it couldn't see; the version that followed only
  assignments to the name itself missed `diagnostics/lookup-test.ts`, which
  wrote the database's message into its result object and logged nothing.
- **What the tripwire cannot see**, each with a site in the tree today, not yet
  changed:
  - A value built in another module. The automation trigger routes
    (`automations/customer-level-recalc.ts`, `automations/lead-housekeeping.ts`,
    `automations/mailchimp-sync.ts`) answer a failed run with a 500 and the run
    itself, whose `errors` are the phases' own messages (`lib/automations/`).
  - Internals that are not an error's. `admin/database/restore.ts` answers
    psql's stderr as `details` in its two 500s, and the first of them logs
    nothing.
  - Also: the error of a callback that is not a promise's
    (`form.parse(req, (err) => ...)`), a status an error carries
    (`res.status(err.status)`), and a body handed to a function that sends it.
- Some of those 500s were refusals, and their messages went with them. Each
  is now decided before the work starts, or by a typed error, and answered
  with a 4xx:
  - **An upload the parser refuses is a 4xx that says what to fix.**
    formidable refuses by failing `parse()` with an error coded 4xx; an upload
    route's catch asks `uploadRefusal(err, preset)` (`lib/secureUpload.ts`)
    first. A file over the size limit or one too many files is a 413 that says
    the limit, an empty file a 400 "The file is empty.", too many form fields a
    413, and a body it can't read as a form (cut off on its way, no boundary,
    not multipart) a 4xx "The upload couldn't be read." formidable's
    `cannotCreateDir` is coded 409 but is the server's directory, so it stays
    a 500. A file of a type the preset does not take is dropped by its filter,
    so the route finds no file and answers a 400 naming the types it takes
    (`noFileMessage(preset)`: "Upload a .pdf file."), as the product picture's
    route does. Seven routes ask so far (the service sheet import, the two
    order-tool previews, the four purchasing PDF routes); the other upload
    routes still answer a refused upload with their 500, or with formidable's
    own text in a 400, and "No file uploaded".
  - **No consignment vendor** is a 404 from `consignmentVendorOr404`
    (`docs/domains/consignment.md`).
  - **The email-marketing customer sync without its key or audience** is a
    400 from a typed error (`docs/domains/mailchimp.md`, "Audience sync").

## Database Schema Domains

| Domain | Key Models | Purpose |
|--------|-----------|---------|
| Catalog | Vendor, VendorStyle, Product, Collection | Product catalog management |
| Pricing | PriceList, VendorPriceDimension, PriceDimensionTier, StyleGradePrice, FabricCatalog | Multi-dimensional pricing engine |
| Options | VendorOptionGroup, VendorOption, StyleOptionOverride | Configurable add-ons and surcharges |
| Taxonomy | Department, Category, Type | Product classification hierarchy |
| Inventory | PhysicalInventoryCount, InventorySnapshot, InventoryTransfer | Barcode scanning and reconciliation |
| Sales | Customer, SalesOrder, OrderLineItem, Invoice, Payment | Sales pipeline |
| Purchasing | PurchaseOrder, PurchaseOrderItem, ReceivingRecord | Vendor purchasing |
| Staff | StaffMember, StaffShift, UpBoardEntry | Staff rotation board |
| Auth | User, Account, Session | NextAuth authentication |
| Marketing | MailchimpCampaign, MailchimpActivity | Email campaign tracking |

## File Organization

- **API routes** (`src/pages/api/`) mirror the data domain
- **Shared business logic** lives in `src/lib/` (never in API routes or components)
- **Vendor-specific parsers** live in `src/lib/pricing/`
- **React components** follow the pattern: `src/components/{domain}/{ComponentName}.tsx`
- **Page layouts**: back-office chrome comes from `src/app/(dashboard)/layout.tsx` (`AppShell` in `src/components/navigation/`); `src/components/layout/` holds `CardGrid` (hub pages), `ScannerLayout`, `MinimalLayout` and `CsvImportForm`
