-- GAP-04b: items that are not taxed, and items taxed under their own group.
--
-- Every TaxRule already belongs to a TaxGroup, but nothing tied a product to a
-- group, so the resolver read every rule in the district regardless of group
-- (lib/tax/resolveTaxRate.ts, "Per-product TaxGroup selection"). These columns
-- are that link:
--
--   Category.taxGroupId   the group its products sell under;
--   Product.taxGroupId    a product's own override of its category's group;
--   TaxGroup.exempt       "not taxed": 0% in every district.
--
-- A line's rate: a not-taxed group is 0%; a group with its own rules in the
-- district uses those; anything else uses the district's rules exactly as
-- before. All three columns default to "no change" (null, null, false), so no
-- existing deployment's tax moves until an admin assigns a group.
ALTER TABLE "Category" ADD COLUMN "taxGroupId" INTEGER;

ALTER TABLE "Product" ADD COLUMN "taxGroupId" INTEGER;

ALTER TABLE "TaxGroup" ADD COLUMN "exempt" BOOLEAN NOT NULL DEFAULT false;

-- SET NULL only matters if a group row is removed by hand: the group delete
-- route refuses while any category or product still uses it.
ALTER TABLE "Product" ADD CONSTRAINT "Product_taxGroupId_fkey" FOREIGN KEY ("taxGroupId") REFERENCES "TaxGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Category" ADD CONSTRAINT "Category_taxGroupId_fkey" FOREIGN KEY ("taxGroupId") REFERENCES "TaxGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
