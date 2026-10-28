-- Two answers the getting-started checklist (lib/gettingStarted.ts) needs and
-- the defaults cannot give.
--
-- setupConfirmedAt: when the owner confirmed currency, locale and timezone.
-- Each has a column default, so a row that was never touched looks exactly
-- like one an owner checked and kept. The timestamp is the only way to tell
-- "chose USD / America/New_York" from "never looked".
--
-- cashOnlyAcknowledgedAt: when the owner said the store takes no card
-- payments. Without it, a store with no card processor configured cannot be
-- told apart from one that simply has not configured it yet.
--
-- Both nullable, no backfill: nobody has confirmed anything until they do.
ALTER TABLE "AppSettings" ADD COLUMN "setupConfirmedAt" TIMESTAMP(3);
ALTER TABLE "AppSettings" ADD COLUMN "cashOnlyAcknowledgedAt" TIMESTAMP(3);
