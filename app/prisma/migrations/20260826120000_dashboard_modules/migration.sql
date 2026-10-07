-- The Up Board and Store Traffic become optional modules.
--
-- Both were hardcoded onto the dashboard, which put two permanently-empty cards
-- on the first screen after login for any deployment that has neither a
-- showroom rotation nor a door counter. An empty traffic card is worse than
-- absent: it does not read as "no counter here", it reads as "nobody came in".
--
-- They default OFF, because most businesses have neither. But a deployment
-- ALREADY using one must not lose it on upgrade, so enable each where there is
-- evidence it is in use -- rows in the table it drives.
UPDATE "AppSettings" s
SET "features" = COALESCE(s."features", '{}'::jsonb) || '{"upBoard": true}'::jsonb
WHERE EXISTS (SELECT 1 FROM "UpBoardEntry");

UPDATE "AppSettings" s
SET "features" = COALESCE(s."features", '{}'::jsonb) || '{"storeTraffic": true}'::jsonb
WHERE EXISTS (SELECT 1 FROM "TrafficSnapshot");
