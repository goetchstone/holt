-- AppSettings.sourceAdapterId -- which prior system this deployment pulls from.
--
-- "none" is the shipped default and a real answer: a deployment that keys
-- everything in holt imports nothing. Before this column the only answer
-- available was the Ordorite adapter, so "we have no source system" and
-- "Ordorite, misconfigured" were the same state.

ALTER TABLE "AppSettings" ADD COLUMN "sourceAdapterId" TEXT NOT NULL DEFAULT 'none';

-- Backfill: any deployment already running the Ordorite import has the
-- `legacyPosImport` module enabled, and that flag is what gated the import
-- route. Carrying it across is the guarantee that an existing deployment's
-- nightly import keeps running -- without it, Saybrook's cron would start
-- reporting "nothing to import" and every report would quietly go stale.
UPDATE "AppSettings"
SET "sourceAdapterId" = 'ordorite'
WHERE ("features" -> 'legacyPosImport')::text = 'true';
