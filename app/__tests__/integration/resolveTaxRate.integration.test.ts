// /app/__tests__/integration/resolveTaxRate.integration.test.ts
//
// Real-DB coverage for resolveTaxDistrict's resolution order. This is the
// logic that replaced `tx.taxDistrict.findFirst({ where: { shortName: "CT"
// } })` -- a literal that meant a deployment outside Connecticut charged
// zero sales tax -- so it's exercised against actual Prisma queries rather
// than mocked ones (CLAUDE.md rule 12: real-DB integration tests are the
// default behind Prisma). rateForLineAmount's pure per-line banding logic
// is unit-tested instead, in __tests__/lib/tax/resolveTaxRate.test.ts.

jest.mock("@/lib/logger", () => ({
  logError: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { resolveTaxDistrict } from "@/lib/tax/resolveTaxRate";
import { logger } from "@/lib/logger";

async function makeDistrict(shortName: string, taxRate: number) {
  const district = await prisma.taxDistrict.create({
    data: { shortName, state: shortName, name: `${shortName} Sales Tax`, isActive: true },
  });
  const group = await prisma.taxGroup.create({ data: { name: `${shortName} Group` } });
  await prisma.taxRule.create({
    data: { districtId: district.id, groupId: group.id, taxRate, sortOrder: 0 },
  });
  return district;
}

describe("resolveTaxDistrict (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("resolves nothing and warns, naming the store, when no district is configured anywhere", async () => {
    const result = await resolveTaxDistrict(prisma, { contextLabel: "Uncle Bob's Pop-Up" });

    expect(result).toEqual({
      taxDistrictId: null,
      isExempt: false,
      source: "unresolved",
      rules: [],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no tax district resolved"),
      expect.objectContaining({ store: "Uncle Bob's Pop-Up" }),
    );
  });

  it("falls back to AppSettings.defaultTaxDistrictId when neither customer nor store resolves", async () => {
    const ct = await makeDistrict("CT", 0.0635);
    const org = await prisma.organization.create({ data: { name: "Test Org", slug: "test-org" } });
    await prisma.appSettings.create({
      data: { organizationId: org.id, defaultTaxDistrictId: ct.id },
    });

    const result = await resolveTaxDistrict(prisma, { contextLabel: "no store on this order" });

    expect(result.taxDistrictId).toBe(ct.id);
    expect(result.source).toBe("app-default");
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].taxRate).toBe(0.0635);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("prefers the selling store's own district over AppSettings.defaultTaxDistrictId", async () => {
    const ct = await makeDistrict("CT", 0.0635);
    const ny = await makeDistrict("NY", 0.08);
    const org = await prisma.organization.create({ data: { name: "Test Org", slug: "test-org" } });
    await prisma.appSettings.create({
      data: { organizationId: org.id, defaultTaxDistrictId: ct.id },
    });
    const store = await prisma.storeLocation.create({
      data: { name: "NY Store", code: "NYS", type: "STORE", taxDistrictId: ny.id },
    });

    const result = await resolveTaxDistrict(prisma, {
      storeLocationId: store.id,
      contextLabel: store.name,
    });

    expect(result.taxDistrictId).toBe(ny.id);
    expect(result.source).toBe("store-district");
    expect(result.rules[0].taxRate).toBe(0.08);
  });

  it("prefers the customer's own district over the store's district", async () => {
    const ny = await makeDistrict("NY", 0.08);
    const ma = await makeDistrict("MA", 0.0625);
    const store = await prisma.storeLocation.create({
      data: { name: "NY Store", code: "NYS2", type: "STORE", taxDistrictId: ny.id },
    });
    const customer = await prisma.customer.create({
      data: { firstName: "Trade", lastName: "Account", defaultTaxDistrictId: ma.id },
    });

    const result = await resolveTaxDistrict(prisma, {
      customerId: customer.id,
      storeLocationId: store.id,
      contextLabel: store.name,
    });

    expect(result.taxDistrictId).toBe(ma.id);
    expect(result.source).toBe("customer-district");
  });

  it("customer exemption zeroes the rules but still records the district that would have applied", async () => {
    // Matches the pre-existing behaviour exactly: the old code always set
    // taxDistrictId from the resolved district and only zeroed taxRate for
    // an exemption, so reporting can still see which jurisdiction a resale
    // exemption applied in.
    const ny = await makeDistrict("NY", 0.08);
    const store = await prisma.storeLocation.create({
      data: { name: "NY Store", code: "NYS3", type: "STORE", taxDistrictId: ny.id },
    });
    const reason = await prisma.taxExemptReason.create({ data: { name: "Resale" } });
    const customer = await prisma.customer.create({
      data: { firstName: "Resale", lastName: "Buyer", taxExemptReasonId: reason.id },
    });

    const result = await resolveTaxDistrict(prisma, {
      customerId: customer.id,
      storeLocationId: store.id,
      contextLabel: store.name,
    });

    expect(result.isExempt).toBe(true);
    expect(result.taxDistrictId).toBe(ny.id);
    expect(result.rules).toEqual([]);
  });

  it("loads only isActive rules, sorted by sortOrder", async () => {
    const district = await prisma.taxDistrict.create({
      data: { shortName: "MULTI", state: "MULTI", name: "Multi-rule district", isActive: true },
    });
    const group = await prisma.taxGroup.create({ data: { name: "Multi Group" } });
    await prisma.taxRule.create({
      data: {
        districtId: district.id,
        groupId: group.id,
        taxRate: 0.99,
        sortOrder: 5,
        isActive: false,
      },
    });
    await prisma.taxRule.create({
      data: { districtId: district.id, groupId: group.id, taxRate: 0.02, sortOrder: 1 },
    });
    await prisma.taxRule.create({
      data: { districtId: district.id, groupId: group.id, taxRate: 0.01, sortOrder: 0 },
    });
    const store = await prisma.storeLocation.create({
      data: { name: "Multi Store", code: "MLT", type: "STORE", taxDistrictId: district.id },
    });

    const result = await resolveTaxDistrict(prisma, {
      storeLocationId: store.id,
      contextLabel: store.name,
    });

    // The inactive 0.99 rule is excluded; the remaining two come back in
    // sortOrder, not creation order.
    expect(result.rules.map((r) => r.taxRate)).toEqual([0.01, 0.02]);
  });

  it("warns once, naming the district and rule ids, when a rule uses chained calc or tax-included pricing -- without failing the sale", async () => {
    const district = await prisma.taxDistrict.create({
      data: { shortName: "VAT", state: "VAT", name: "VAT-style district", isActive: true },
    });
    const group = await prisma.taxGroup.create({ data: { name: "VAT Group" } });
    const included = await prisma.taxRule.create({
      data: {
        districtId: district.id,
        groupId: group.id,
        taxRate: 0.2,
        sortOrder: 0,
        taxIncludedInSalesPrice: true,
      },
    });
    const store = await prisma.storeLocation.create({
      data: { name: "VAT Store", code: "VATS", type: "STORE", taxDistrictId: district.id },
    });

    const result = await resolveTaxDistrict(prisma, {
      storeLocationId: store.id,
      contextLabel: store.name,
    });

    // Still resolves and still returns the rule -- this is a documented
    // gap, not a hard failure.
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].taxIncludedInSalesPrice).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("chained calculation"),
      expect.objectContaining({ taxDistrictId: district.id, ruleIds: [included.id] }),
    );
  });
});
