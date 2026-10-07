-- Till variance discipline (Phase 0.6, docs/domains/pos.md) — escalation
-- block. A till closing with |variance| > $100 marks its Register blocked
-- (blockedAt set) so pages/api/registers/[id]/tills/open.ts refuses new
-- opens there until a MANAGER/ADMIN clears it via
-- POST /api/registers/[id]/unblock. Both columns are nullable and additive
-- — no backfill needed, no existing rows affected.

-- AlterTable
ALTER TABLE "Register" ADD COLUMN     "blockReason" TEXT,
ADD COLUMN     "blockedAt" TIMESTAMP(3);
