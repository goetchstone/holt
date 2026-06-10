-- Invoice authoring (composer + issuance). Two changes:
--
-- 1. Invoice gains organizationId (tenant scoping for authored invoices;
--    legacy imported invoices stay NULL), notes, issuedAt, and audit columns.
-- 2. InvoiceLineItem gains freeform-line columns (description, quantity,
--    unitPrice, amount, sortOrder) and orderLineItemId becomes nullable so an
--    authored line need not reference an OrderLineItem. deliveredQuantity
--    defaults to 0 for freeform lines. Postgres unique indexes permit
--    multiple NULL orderLineItemId rows, so the existing unique constraint
--    keeps protecting legacy delivery lines without blocking freeform lines.

-- AR journal types for invoice issuance + payment postings. Values are only
-- used at runtime (never in this migration), so adding them inside the
-- migration transaction is safe on PostgreSQL 12+.
ALTER TYPE "JournalType" ADD VALUE 'AR_SALE';
ALTER TYPE "JournalType" ADD VALUE 'AR_PAYMENT';

ALTER TABLE "Invoice" ADD COLUMN "organizationId" INTEGER;
ALTER TABLE "Invoice" ADD COLUMN "notes" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "issuedAt" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN "createdBy" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "updatedBy" TEXT;

ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Invoice_organizationId_status_idx" ON "Invoice"("organizationId", "status");

-- Structural binding for invoice payments: the Stripe webhook routes on this
-- column, never on session metadata alone. Mirrors Payment.salesOrderId.
ALTER TABLE "Payment" ADD COLUMN "invoiceId" INTEGER;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Payment_invoiceId_idx" ON "Payment"("invoiceId");

ALTER TABLE "InvoiceLineItem" ALTER COLUMN "orderLineItemId" DROP NOT NULL;
ALTER TABLE "InvoiceLineItem" ALTER COLUMN "deliveredQuantity" SET DEFAULT 0;
ALTER TABLE "InvoiceLineItem" ADD COLUMN "description" TEXT;
ALTER TABLE "InvoiceLineItem" ADD COLUMN "quantity" DECIMAL(65,30);
ALTER TABLE "InvoiceLineItem" ADD COLUMN "unitPrice" DECIMAL(65,30);
ALTER TABLE "InvoiceLineItem" ADD COLUMN "amount" DECIMAL(65,30);
ALTER TABLE "InvoiceLineItem" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;
