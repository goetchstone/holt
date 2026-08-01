-- Home Accessory Order Import tool: one new BuyerDraftSource enum value so
-- items it creates are visually distinguishable from MANUAL drafts, same
-- rationale as HISTORICAL_PO_IMPORT before it. No column changes — the
-- BuyerDraftItem.source column already exists and just gains a new legal
-- value. Additive, backward-compatible; existing rows are untouched.
--
-- Note: `prisma migrate dev` initially also emitted unrelated statements
-- (dropping the LegacyOrder trigram GIN indexes + a no-op FK drop/re-add on
-- InvoiceLineItem) — pre-existing drift between this dev DB and
-- schema.prisma unrelated to this change (Prisma's declarative schema
-- can't represent `USING gin (... gin_trgm_ops)` indexes, so any
-- `migrate dev` run in this repo will propose dropping them). Trimmed back
-- to just the intended change; the trigram indexes were restored in the
-- dev DB by hand and are untouched by this migration.

ALTER TYPE "BuyerDraftSource" ADD VALUE 'HOME_ACCESSORY_ORDER_IMPORT';
