-- Places contain places (ledger plan phase 12, lib/inventory/placeTree.ts).
--
-- StockLocation.parentId nests places as deep as a store wants. The free-text
-- building / floor / area columns are retired (one home per fact, rule 6):
--   - each distinct building at a store becomes a GROUP place (a place that
--     holds places, never stock), coded BLDG-<NAME>;
--   - each distinct floor becomes a GROUP place inside its building (or at the
--     top of the store when the place had no building), coded FLR-..., named
--     "<building> Floor <n>";
--   - every place is put inside its floor, or its building when it had no floor.
-- The area number is not carried: it was an index within a floor, and the
-- places' own codes already carry it (measured on a restored copy before
-- writing this: 60 places, 42 with a building across 3 buildings, 54 with a
-- floor and an area, every area number also in the place's code). Codes are
-- left as they are: buyer-draft exports send them (rule 45).

ALTER TABLE "StockLocation" ADD COLUMN "parentId" INTEGER;

-- Buildings.
INSERT INTO "StockLocation" ("storeLocationId", "code", "name", "locationType", "locationAliases", "createdBy", "updated")
SELECT DISTINCT "storeLocationId",
       'BLDG-' || upper(regexp_replace(trim(building), '[^A-Za-z0-9]+', '-', 'g')),
       trim(building), 'GROUP', ARRAY[]::text[], 'system', CURRENT_TIMESTAMP
FROM "StockLocation"
WHERE building IS NOT NULL AND trim(building) <> ''
ON CONFLICT ("storeLocationId", "code") DO NOTHING;

-- Floors, inside their building.
INSERT INTO "StockLocation" ("storeLocationId", "code", "name", "locationType", "locationAliases", "createdBy", "updated", "parentId")
SELECT DISTINCT sl."storeLocationId",
       'FLR-' || COALESCE(upper(regexp_replace(trim(sl.building), '[^A-Za-z0-9]+', '-', 'g')) || '-', '') || sl.floor,
       COALESCE(trim(sl.building) || ' ', '') || 'Floor ' || sl.floor,
       'GROUP', ARRAY[]::text[], 'system', CURRENT_TIMESTAMP,
       b.id
FROM "StockLocation" sl
LEFT JOIN "StockLocation" b
  ON b."storeLocationId" = sl."storeLocationId"
 AND b.code = 'BLDG-' || upper(regexp_replace(trim(sl.building), '[^A-Za-z0-9]+', '-', 'g'))
 AND b."locationType" = 'GROUP'
WHERE sl.floor IS NOT NULL AND sl."locationType" <> 'GROUP'
ON CONFLICT ("storeLocationId", "code") DO NOTHING;

-- Every place inside its floor, or its building.
UPDATE "StockLocation" sl
SET "parentId" = COALESCE(f.id, b.id)
FROM "StockLocation" self
LEFT JOIN "StockLocation" b
  ON b."storeLocationId" = self."storeLocationId"
 AND b.code = 'BLDG-' || upper(regexp_replace(trim(self.building), '[^A-Za-z0-9]+', '-', 'g'))
 AND b."locationType" = 'GROUP'
LEFT JOIN "StockLocation" f
  ON f."storeLocationId" = self."storeLocationId"
 AND f.code = 'FLR-' || COALESCE(upper(regexp_replace(trim(self.building), '[^A-Za-z0-9]+', '-', 'g')) || '-', '') || self.floor
 AND f."locationType" = 'GROUP'
WHERE sl.id = self.id
  AND sl."locationType" <> 'GROUP'
  AND (sl.floor IS NOT NULL OR (sl.building IS NOT NULL AND trim(sl.building) <> ''));

-- Lossless or nothing: a place that had a building or a floor and ended up in
-- no group would lose where it is.
DO $$
DECLARE stranded integer;
BEGIN
  SELECT count(*) INTO stranded FROM "StockLocation"
  WHERE "locationType" <> 'GROUP'
    AND (floor IS NOT NULL OR (building IS NOT NULL AND trim(building) <> ''))
    AND "parentId" IS NULL;
  IF stranded > 0 THEN
    RAISE EXCEPTION 'places_contain_places: % place(s) would lose their building or floor', stranded;
  END IF;
END $$;

ALTER TABLE "StockLocation" DROP COLUMN "area",
DROP COLUMN "building",
DROP COLUMN "floor";

ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
