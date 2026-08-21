-- Department reporting roles.
--
-- crossSell.ts and designerDashboard.ts each carried a hardcoded list of
-- department NAMES -- one retailer's merchandise taxonomy compiled into shared
-- report code. For any other deployment those reports bucketed everything into
-- "Home Shop" and offered an empty cross-sell list, silently (CLAUDE.md rule
-- 61: deployment facts are config, not literals).
--
-- The backfill below reproduces the previous classifiers EXACTLY, so every
-- existing deployment reports identical numbers across this migration.

ALTER TABLE "Department" ADD COLUMN "reportGroup" TEXT;
ALTER TABLE "Department" ADD COLUMN "crossSellTarget" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Department" ADD COLUMN "crossSellAnchor" BOOLEAN NOT NULL DEFAULT false;

-- getCategoryForDepartment(), transcribed. Order is load-bearing: the excluded
-- test ran first, then the map in declaration order, with "Home Shop" as the
-- fallthrough rather than a matched keyword.
--
-- Two collapses are deliberate, not sloppy: the old EXCLUDED list held
-- "apparel", "mens apparel" and "womens apparel", but matching was
-- `lower.includes(kw)`, so "apparel" alone already covered the other two.
-- Likewise "rugs" and "rug" both reduce to '%rug%'. Same set of rows, fewer
-- branches.
UPDATE "Department" SET "reportGroup" = CASE
  WHEN lower("name") LIKE '%apparel%'
    OR lower("name") LIKE '%accessories%'   THEN NULL
  WHEN lower("name") LIKE '%furniture%'     THEN 'Furniture'
  WHEN lower("name") LIKE '%curtains%'
    OR lower("name") LIKE '%window%'        THEN 'Window Treatments'
  WHEN lower("name") LIKE '%rug%'           THEN 'Rugs'
  ELSE 'Home Shop'
END;

-- TARGET_DEPTS from crossSell.ts. That comparison was an exact-name match
-- against the department string on the order line, so this stays exact.
UPDATE "Department" SET "crossSellTarget" = true
WHERE "name" IN (
  'Rugs', 'Curtains', 'Outdoor Furniture', 'Lamps',
  'Bedding', 'Womens Apparel', 'Mens Apparel', 'Home Acc'
);

-- The anchor: crossSell.ts qualified customers on `dept = 'Furniture'` spend.
UPDATE "Department" SET "crossSellAnchor" = true WHERE "name" = 'Furniture';
