-- AppSettings.portalTokenTtlHours: lifetime of an order-portal link, in hours.
-- Nullable and unset by default: unset resolves to 48 hours (appSettings.ts).
-- Order-portal links are non-revocable capability tokens (lib/portalToken.ts),
-- so their lifetime is the only revocation there is; it was a fixed 7 days
-- before SEC-08. The settings API accepts 1-168.
ALTER TABLE "AppSettings" ADD COLUMN "portalTokenTtlHours" INTEGER;
