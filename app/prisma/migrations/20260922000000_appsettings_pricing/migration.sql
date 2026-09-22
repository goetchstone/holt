-- AppSettings.pricing: store-wide retail markup fallback, { "defaultMarkup": n }.
-- Nullable and unset by default: with neither a vendor markup nor this, the
-- catalog shows wholesale cost and refuses to invent a retail price (USE-04),
-- rather than defaulting to another business's 2.5x multiplier.
ALTER TABLE "AppSettings" ADD COLUMN "pricing" JSONB;
