-- Tenders a store sets up for itself: each finance company, Zelle, a trade-in.
-- The built-in methods stay compile-time (rule 62: config selects behaviour);
-- a Tender only names a payment type and picks which built-in kind it behaves
-- and reports as. lib/payments/tenders.ts creates its POS_PAYMENTS GL mapping
-- alongside it, so its payments reach the sales journal.
--
-- Payment.reference holds what the payer quotes (a finance approval number, a
-- wire reference). Until now an invoice payment's reference was kept only for
-- checks, in checkNumber, and dropped for every other method.
--
-- No backfill: no payment was made with a store tender before this table.
CREATE TABLE "Tender" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PaymentMethod" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "atRegister" BOOLEAN NOT NULL DEFAULT true,
    "onInvoices" BOOLEAN NOT NULL DEFAULT true,
    "referenceRequired" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "Tender_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Tender_name_key" ON "Tender"("name");

ALTER TABLE "Payment" ADD COLUMN "tenderId" INTEGER;
ALTER TABLE "Payment" ADD COLUMN "reference" TEXT;

CREATE INDEX "Payment_tenderId_idx" ON "Payment"("tenderId");

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tenderId_fkey" FOREIGN KEY ("tenderId") REFERENCES "Tender"("id") ON DELETE SET NULL ON UPDATE CASCADE;
