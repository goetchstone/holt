# Architecture Guide — Holt

This document explains how the system is structured, what each module does, and where data flows. Read OPERATIONS.md for deployment and maintenance.

Holt is open-core: the same codebase serves a self-hosted single-organization deployment and a multi-tenant SaaS where each customer is one `Organization`. Per-organization branding, integration credentials, and import mappings live in the database (see the `AppSettings` and `IntegrationCredential` models), so a deployment is configured at runtime rather than at build time.

## Application Structure

The app is a Next.js 16 application on the **App Router + tRPC** (the modern-stack target borrowed from the akritos reference build). The Pages-Router → App-Router migration is **complete**: all ~200 feature pages are App Router; the Pages Router is retained only for the `auth/login` entry and the `src/pages/api/**` REST routes.

- **App Router** (`src/app/`) — every feature page. Server components under route groups (`(dashboard)` supplies the shared nav chrome; `app/portal/*` is the public, no-auth customer surface; `app/print/*` are minimal-chrome render targets) gate via `requirePage()` and render `"use client"` views. Typed data flows through **tRPC** (`src/server/trpc/`), with query logic in framework-agnostic libs (`src/lib/reports/*` etc.).
- **REST API** (`src/pages/api/`) — retained by design for exports, mutations, cross-domain shared endpoints (`/api/staff`, `/api/departments`, `/api/dashboard/weekly`, `/api/mailchimp/*`), Stripe/webhook handlers, and file uploads. App Router views call these directly where tRPC isn't the right fit (downloads, multipart, third-party callbacks).

The database is accessed through Prisma ORM in every path. See `MIGRATION-PLAN.md` for the per-domain ledger + the canonical port recipe, and `docs/QUALITY.md` for the SonarQube quality gate.

```
Browser (iPad / Laptop)
    |
    v
App Router server components (src/app/**/page.tsx)  ->  "use client" views
    |                                                        |
    |  requirePage() gate                                    |  api client (tRPC) / fetch (REST)
    v                                                        v
tRPC routers (src/server/trpc/)  ────────────────┐     REST API routes (src/pages/api/**)
    |   (reads)                                    │        |  (exports, mutations, uploads, webhooks, shared)
    v                                              v        v
Report/query libs (src/lib/reports/*.ts)  <─── shared ──>  Service Layer (src/lib/*.ts)
    |
    v
Prisma ORM (prisma/schema.prisma)
    |
    v
PostgreSQL 17
```

## Module Map

### Sales Flow

```
Customer walks in
    -> Designer creates Quote (sales/quotes/new.tsx)
    -> Customer pays deposit (sales/orders/[id].tsx -> paymentService.ts)
    -> QUOTE promotes to ORDER (paymentService.onPaymentReceived)
    -> POs auto-created for vendor items (paymentService.onPaymentReceived)
    -> Vendor ships, warehouse receives (purchasing/orders/[id]/receive.tsx)
    -> Order invoiced, promotes to FULFILLED (import or manual)
    -> Customer picks up or gets delivery scheduled (service/dispatch.tsx)
```

**Key files:**

- `src/lib/paymentService.ts` -- Payment recording, refunds, balance calculation, order promotion
- `src/pages/api/sales/orders/` -- CRUD for sales orders and line items
- `src/pages/api/purchasing/orders/` -- Purchase order management

### Pricing Engine

```
Vendor sends price list (PDF or Excel)
    -> Admin uploads (admin/pricing/import/)
    -> Parser extracts data (lib/pricing/*.ts)
    -> Creates VendorStyles (catalog templates) + Products (physical items)
    -> Grade/species/multi-axis prices stored per dimension tier
    -> Configurator calculates retail price (tools/configurator.tsx)
```

Each vendor has a `VendorPricingModel` that determines which pricing path to follow:

| Model | Example Vendor | How It Works |
|-------|---------------|--------------|
| FLAT | Simple vendors | One price per product |
| GRADE_BASED | Wesley Hall, CR Laine | Price varies by fabric/leather grade |
| FRAME_PLUS_CUSHION | Some upholstery | Base frame + cushion grade surcharge |
| SPECIES_MATRIX | Gat Creek | Price varies by wood species |
| MULTI_AXIS | Complex vendors | Up to 3 independent price dimensions |
| AREA_BASED | Rugs | Price by square footage |
| SIZE_BASED | Some vendors | Price tiers by size |

**Key files:**

- `src/lib/pricing/` -- PDF and data parsers per vendor
- `src/pages/api/pricing/import/` -- Import endpoints (one per vendor/format)
- `src/lib/pricing/priceCalculator.ts` -- Retail price computation

### Inventory

```
Physical count (iPad barcode scanner)
    -> inventory/physical-count.tsx scans barcodes
    -> Counts stored in PhysicalInventoryCount
    -> Compared against an imported inventory snapshot (InventorySnapshot)
    -> Variance report generated (inventory/variance-report.tsx)
    -> Reconciliation recorded
```

**Key files:**

- `src/pages/inventory/physical-count.tsx` -- Scanner page
- `src/pages/api/inventory/` -- Count submission, reconciliation

### Import Pipeline

```
Export CSV from a source system (POS, ERP, spreadsheet)
    -> Upload via the import UI (or scheduled connector)
    -> Column mapping resolves source columns to internal fields
    -> API route parses CSV, maps to internal models
    -> Upserts products, orders, invoices, payments
    -> Links to existing records by external IDs
```

Imports are driven by configurable column mappings, so a deployment can ingest
whatever its source system exports. Common POS/ERP formats ship as reusable
presets; the POS preset is the reference implementation.

The pipeline handles these entity types:

- Products (with UPC barcodes, categories, departments)
- Customers (with addresses and external customer IDs)
- Sales orders (with line items)
- Invoices (with delivered quantities)
- Payments (with type codes mapped to readable names)
- Purchase orders (with receiving records)
- Inventory snapshots

**Key files:**

- `src/lib/importHelpers.ts` -- reference preset: CSV parsing, field mapping, payment type resolution
- `src/lib/importRunners.ts` -- standalone runners shared by manual upload and scheduled imports

### Service Dispatch

```
Order confirmed with service line items
    -> paymentService.onPaymentReceived() calls syncServiceAppointments()
    -> PENDING appointments created automatically
    -> Dispatcher assigns installer and date (service/dispatch.tsx)
    -> Status: PENDING -> SCHEDULED -> CONFIRMED -> IN_PROGRESS -> COMPLETED
```

Service types: MEASURE, INSTALL, DELIVERY, HOUSE_CALL

House calls are designer appointments (not installer dispatch) and have their own pages under `service/house-calls/`.

**Key files:**

- `src/lib/serviceDispatchService.ts` -- State machine, appointment creation
- `src/pages/api/service/dispatch/` -- Dispatch queue API
- `src/pages/api/service/house-calls/` -- House call API

### Returns

```
Customer requests return
    -> Portal link sent (sales/orders/[id].tsx -> return-link API)
    -> Customer fills form (portal/return/[token].tsx)
    -> Staff reviews (sales/returns/[id].tsx)
    -> Status: INITIATED -> RECEIVED -> INSPECTED -> RESTOCKED/WRITTEN_OFF/CLOSED
    -> Refund processed through paymentService.processRefund()
```

**Key files:**

- `src/lib/returnService.ts` -- State machine, disposition suggestions
- `src/pages/api/returns/` -- Return CRUD and status transitions

### Gift Cards

```
Sale: sales/gift-card-sale.tsx creates card + activation payment
Redemption: paymentService.recordPayment() with method=GIFT_CARD
    -> Checks balance, creates GiftCardTransaction, updates currentBalance
Refund: paymentService.processRefund() with method=GIFT_CARD
    -> Credits balance back to card
```

**Key files:**

- `src/pages/api/gift-cards/` -- CRUD, activation, redemption, import
- Gift card logic embedded in `src/lib/paymentService.ts`

### Staff Up-Board

```
Staff rotation board for sales floor
    -> Tracks who is "up" (next to help a customer)
    -> Rotates position after customer interaction
    -> Manages status: AVAILABLE, WITH_CUSTOMER, BREAK, OFF_FLOOR
```

**Key files:**

- `src/components/dashboard/UpBoard.tsx` -- Real-time board display
- `src/pages/api/up-board/` -- Position management

### Reporting

```
Dashboard (reports/dashboard.tsx)
    -> Store traffic (door-counter API integration)
    -> Daily/weekly sales aggregation
    -> Till reconciliation
    -> Mailchimp campaign metrics
```

### Feedback System

```
User clicks floating button (components/FeedbackButton.tsx)
    -> Submits to /api/feedback
    -> Creates GitHub Issue via GitHub App auth
    -> Labels by category (bug, data, enhancement, question)
```

## Data Model Overview

### Core Relationships

```
Vendor -> VendorStyle (catalog template) -> Product (physical item)
Product -> ProductVariant (size/color/finish)
Product -> OrderLineItem -> SalesOrder -> Customer
SalesOrder -> Payment
SalesOrder -> Invoice -> InvoiceLineItem
SalesOrder -> PurchaseOrder -> PurchaseOrderItem
SalesOrder -> ServiceAppointment
SalesOrder -> Return
```

### Pricing Relationships

```
Vendor -> VendorPriceDimension (e.g., "Fabric Grade")
VendorPriceDimension -> PriceDimensionTier (e.g., "Grade 14", "Grade 15")
VendorStyle + PriceDimensionTier -> StyleGradePrice (cost at that tier)
```

### Key Identifiers

- **orderno**: source-system order number (e.g., "SO-12345"), unique
- **productNumber**: Vendor part number, unique per vendor
- **paymentCode**: source-system payment ID, globally unique
- **appointmentNumber**: Generated as `SVC-YYMMDD-NNN`
- **returnNumber**: Generated as `RET-YYMMDD-NNN`
- **poNumber**: Generated as `PO-YYMMDD-NNN`

## Authentication and Authorization

- Google OAuth via NextAuth 4 (JWT sessions, no database sessions)
- Roles (`StaffRole` enum): SUPER_ADMIN, ADMIN, MANAGER, DESIGNER, REGISTER, WAREHOUSE, INSTALLER, MARKETING. SUPER_ADMIN auto-satisfies ADMIN checks.
- Auth check: `requireAuth()` / `requireAuthWithRole(["MANAGER"])` for API routes; `withAuth(gssp?, { roles })` HOC for pages (also injects per-org branding into page props)
- Navigation filtering: `src/lib/auth/navPermissions.ts` controls which nav items each role sees

## External Integrations

All integrations except Google sign-in are optional and configured per
organization at **Admin → Settings → Integrations**. Credentials are stored
encrypted (AES-256-GCM) and decrypted only server-side at the point of use.

| System | Purpose | Auth | Key Files |
|--------|---------|------|-----------|
| Google OAuth | User authentication | OAuth 2.0 | `src/pages/api/auth/[...nextauth].ts` |
| Stripe | Customer portal payments | API key | `src/lib/stripe.ts` |
| Mailchimp | Email campaign sync | API key | `src/pages/api/mailchimp/` |
| POS/ERP CSV | Data import (presets) | CSV export | `src/lib/importHelpers.ts` |
| FileMaker | Sales data retrieval | Username/password | `src/lib/fmApiClient.ts` |
| Door counter | Store traffic data | API key | `src/pages/api/traffic/` |
| GitHub | Issue tracking (feedback) | GitHub App (JWT) | `src/lib/githubApp.ts` |
| ZPL Printers | Label printing | TCP socket (port 9100) | `src/lib/labelPrinter.ts` |

## File Naming Conventions

- **Pages**: `src/pages/<section>/<feature>.tsx` (kebab-case)
- **API routes**: `src/pages/api/<domain>/<resource>.ts` (matches page structure)
- **Components**: `src/components/<category>/<ComponentName>.tsx` (PascalCase)
- **Libraries**: `src/lib/<moduleName>.ts` (camelCase)
- **Tests**: `__tests__/<moduleName>.test.ts` (matches lib file name)

Every source file starts with a path comment: `// /app/src/path/to/file.tsx`

## UI Pages by Section

| Section | Path | Purpose |
|---------|------|---------|
| Dashboard | `/` | Home page with store traffic and up-board |
| Sales | `/sales/` | Orders, customers, POS, till, returns, gift cards |
| Inventory | `/inventory/` | Products, physical counts, variance reports, vendors |
| Purchasing | `/purchasing/` | Purchase orders, receiving, needs-ordering queue |
| Warehouse | `/warehouse/` | Dispatch, transfers, locations, returns processing |
| Service | `/service/` | Dispatch queue, house calls, service cases |
| Reports | `/reports/` | Sales dashboards, Mailchimp, till reconciliation |
| Admin | `/admin/` | Import, pricing, setup, staff, diagnostics |
| Tools | `/tools/` | Configurator, project creation |
| Portal | `/portal/` | Customer-facing order lookup and return requests |

## Testing

- Framework: Jest with ts-jest, split into three projects: `unit` (no I/O), `integration` (Postgres-backed against the live schema), and `performance` (in-memory sizing).
- Tests live in `app/__tests__/`
- Run: `cd app && npm test` (unit), `npm run test:integration` (DB-backed), `npm run test:coverage` (merged gate input)
- Default to pure business-logic tests (state machines, calculations, data mapping); orchestration/runner code is exercised by real-DB integration tests
- Coverage areas: pricing calculation, payment math, return/dispatch transitions, barcode validation, import parsing, ledger/commission runners

## Adding a New Feature (Checklist)

1. Define the data model in `prisma/schema.prisma`
2. Create a migration: write SQL in `prisma/migrations/<name>/migration.sql`
3. Regenerate Prisma client: `npx prisma generate`
4. Write service layer logic in `src/lib/`
5. Write tests in `__tests__/`
6. Create API routes in `src/pages/api/`
7. Create UI pages in `src/pages/`
8. Add nav permissions in `src/lib/auth/navPermissions.ts`
9. Run `npm run validate && npm test`
10. Commit, push, deploy
