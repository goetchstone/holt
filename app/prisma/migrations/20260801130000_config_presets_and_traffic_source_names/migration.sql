-- Config presets: file-or-GUI driven per-deployment mapping.
-- See docs/domains/config-presets.md.

-- Traffic-counter labels for a store's doors. Replaces the hardcoded
-- AXPER_TO_STORE_LOCATION / STORE_DISPLAY_NAMES literals in
-- lib/storeColors.ts. Defaulted to empty so existing rows are valid and the
-- column is backfilled by applying a `traffic-store-mapping` preset.
ALTER TABLE "StoreLocation" ADD COLUMN "trafficSourceNames" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Durable audit trail for preset application. Append-only by convention.
CREATE TABLE "ConfigChangeLog" (
    "id" SERIAL NOT NULL,
    "presetKind" TEXT NOT NULL,
    "presetName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "actor" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfigChangeLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ConfigChangeLog_presetKind_presetName_created_idx" ON "ConfigChangeLog"("presetKind", "presetName", "created");
CREATE INDEX "ConfigChangeLog_created_idx" ON "ConfigChangeLog"("created");
