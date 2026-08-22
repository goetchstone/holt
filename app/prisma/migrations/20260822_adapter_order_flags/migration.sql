-- Adapter-owned per-order state.
--
-- SalesOrder carried `skipSameDayRewriteCleanup`, a boolean only the Ordorite
-- importer has ever read or written. It is a fact about one source system's
-- rewrite quirks, not about the sale, and it sat on the highest-traffic table
-- in the product. In the reference dataset it is set on 1 order out of 49,769.
--
-- AdapterOrderFlag is keyed by (salesOrderId, adapter, flag) so a second adapter
-- needs no schema change to remember its own thing.

CREATE TABLE "AdapterOrderFlag" (
    "id"           SERIAL       NOT NULL,
    "salesOrderId" INTEGER      NOT NULL,
    "adapter"      TEXT         NOT NULL,
    "flag"         TEXT         NOT NULL,
    "value"        BOOLEAN      NOT NULL DEFAULT true,
    "note"         TEXT,
    "created"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated"      TIMESTAMP(3),
    "createdBy"    TEXT,
    "updatedBy"    TEXT,
    CONSTRAINT "AdapterOrderFlag_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdapterOrderFlag_salesOrderId_adapter_flag_key"
    ON "AdapterOrderFlag"("salesOrderId", "adapter", "flag");
CREATE INDEX "AdapterOrderFlag_adapter_flag_idx"
    ON "AdapterOrderFlag"("adapter", "flag");

ALTER TABLE "AdapterOrderFlag"
    ADD CONSTRAINT "AdapterOrderFlag_salesOrderId_fkey"
    FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry the existing overrides across before the column goes. Guarded so the
-- migration runs on a database where the column was never added.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'SalesOrder' AND column_name = 'skipSameDayRewriteCleanup'
  ) THEN
    INSERT INTO "AdapterOrderFlag" ("salesOrderId", "adapter", "flag", "value", "note", "createdBy")
    SELECT id, 'ordorite', 'skipSameDayRewriteCleanup', true,
           'Migrated from SalesOrder.skipSameDayRewriteCleanup', 'migration'
    FROM "SalesOrder"
    WHERE "skipSameDayRewriteCleanup" = true;

    ALTER TABLE "SalesOrder" DROP COLUMN "skipSameDayRewriteCleanup";
  END IF;
END $$;
