-- Stamped by the legacy-POS inbound-items import (full snapshot of open POs).
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "lastSeenInInboundExport" TIMESTAMP(3);
