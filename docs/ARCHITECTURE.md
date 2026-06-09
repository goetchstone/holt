# Architecture

## System Overview

```
                                  Docker Host
                    +-----------------------------------+
                    |                                   |
  iPad/Laptop ---->| Nginx (8080) --> Next.js (3000)   |
                    |                    |              |
                    |                    v              |
                    |              PostgreSQL (5433)    |
                    |                                   |
                    +-----------------------------------+
                                    |
                         Docker Compose (3 services)
```

This is the reference self-hosted topology: a single Docker host running three
Compose services, no load balancer, no CDN, no external database. Simplicity is
intentional — a single store can run the whole stack on modest hardware (the
reference deployment is a Synology NAS). A multi-tenant SaaS deployment scales
the same image horizontally behind a load balancer with a managed Postgres.

## Data Flow: Pricing Import Pipeline

The most complex data path in the system:

```
  Vendor Price List (PDF/CSV/XLSX)
           |
           v
  [Client] Parse & extract
  (pdfTableExtractor / xlsx / papaparse)
           |
           v
  [Client] Normalize via vendor parser
  (wesleyHallParser / gatCreekExtractor / crLaineExtractor)
           |
           v
  [Client] Preview in ImportPreviewTable
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
- **Page layouts** in `src/components/layout/` (MainLayout is the standard wrapper)
