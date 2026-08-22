-- Vendor number prefixes: how a vendor's product and part numbers look.
--
-- lib/consignment.ts hardcoded ONE consignment vendor's numbering: "MAR-" on
-- POS product numbers, "M" on the physical tag. 26 call sites across
-- paymentService, the Ordorite runners and three consignment import routes went
-- through it. A second consignment vendor matched nothing, and did so silently
-- -- no error, just rugs that never linked to their consignment items.
--
-- OPT-IN by construction: a deployment with no rows here has the feature off,
-- and every lookup returns "not a vendor number". Nothing is inferred from a
-- vendor's name or code.
CREATE TABLE "VendorNumberPrefix" (
    "id"            SERIAL       NOT NULL,
    "vendorId"      INTEGER      NOT NULL,
    "prefix"        TEXT         NOT NULL,
    "barcodePrefix" TEXT,
    "note"          TEXT,
    "created"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated"       TIMESTAMP(3),
    "createdBy"     TEXT,
    "updatedBy"     TEXT,
    CONSTRAINT "VendorNumberPrefix_pkey" PRIMARY KEY ("id")
);

-- Globally unique: if two vendors could both claim "MAR-", a number carrying it
-- would resolve to whichever row was read first. Refusing the configuration is
-- better than resolving it arbitrarily.
CREATE UNIQUE INDEX "VendorNumberPrefix_prefix_key" ON "VendorNumberPrefix"("prefix");
CREATE INDEX "VendorNumberPrefix_vendorId_idx" ON "VendorNumberPrefix"("vendorId");
CREATE INDEX "VendorNumberPrefix_barcodePrefix_idx" ON "VendorNumberPrefix"("barcodePrefix");

ALTER TABLE "VendorNumberPrefix"
    ADD CONSTRAINT "VendorNumberPrefix_vendorId_fkey"
    FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry the one scheme that was in code across, where its vendor exists. Guarded
-- so a deployment that never consigned gets an empty table and the feature off.
INSERT INTO "VendorNumberPrefix" ("vendorId", "prefix", "barcodePrefix", "note", "createdBy")
SELECT v.id, 'MAR-', 'M',
       'Migrated from the hardcoded scheme in lib/consignment.ts', 'migration'
FROM "Vendor" v
WHERE lower(v.name) LIKE '%marjan%'
ORDER BY v.id
LIMIT 1
ON CONFLICT ("prefix") DO NOTHING;
