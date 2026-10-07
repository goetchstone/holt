-- TrafficSnapshot.axperStoreName -> sourceStoreName.
--
-- Axper is one door-counter vendor with its own integration, and that
-- integration keeps its name. TrafficSnapshot is not part of it: it is the
-- product's traffic model, read directly by reports/traffic, trafficSummary and
-- the CSV export, and written by lib/runTrafficImport.ts rather than by the
-- adapter. A deployment counting doors with any other hardware had to write its
-- labels into a column named after a vendor it does not use -- and the column
-- is in the unique key, so it is not merely cosmetic.
--
-- The mapping side was already source-neutral (StoreLocation.trafficSourceNames).
-- This brings the snapshot side into line.
--
-- A rename, not a copy: no data moves and the values are untouched.
ALTER TABLE "TrafficSnapshot" RENAME COLUMN "axperStoreName" TO "sourceStoreName";

ALTER INDEX IF EXISTS "TrafficSnapshot_intervalStart_axperStoreName_key"
  RENAME TO "TrafficSnapshot_intervalStart_sourceStoreName_key";
