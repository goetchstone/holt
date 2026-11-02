// /app/__tests__/integration/vendorMerge.integration.test.ts
//
// GAP-22: merging a duplicate vendor into the one the store keeps
// (lib/vendors/mergeVendor.ts). Everything filed under the duplicate moves to
// the kept vendor, the duplicate's name becomes an earlier name of it
// (VendorAlias), and the duplicate is deleted, all or nothing. It refuses,
// naming why, when the two hold records the database keeps one of per vendor,
// when an item would list a vendor twice, when only one takes consignment, and
// when a commission rule names the duplicate.
//
// Every lookup of a vendor by name (lib/vendors/vendorByName.ts) finds the kept
// vendor through an earlier name, so an import that still spells it doesn't
// make the duplicate again: the vendor screen, the generic and Ordorite imports,
// the POS cart.
//
// Real routes, real permission gates, real database; the session readers are
// the only mocks.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
jest.mock("next-auth/jwt", () => ({ getToken: jest.fn() }));
jest.mock("next/headers", () => ({ cookies: jest.fn(), headers: jest.fn() }));
jest.mock("next/navigation", () => ({
  redirect: jest.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { getServerSession } from "next-auth";
import { getToken } from "next-auth/jwt";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { mergeVendor } from "@/lib/vendors/mergeVendor";
import {
  findOrCreateInIndex,
  findVendorByName,
  vendorIdByName,
  vendorNameIndex,
} from "@/lib/vendors/vendorByName";
import { runGenericImport } from "@/lib/genericImportRunner";
import { runPurchaseOrdersImport } from "@/lib/adapters/ordorite/runners";
import { ensureUnknownVendorId } from "@/lib/adapters/ordorite/shared";
import { clearVendorPrefixCacheForTesting } from "@/lib/vendorPrefixService";
import mergeRoute from "@/pages/api/vendors/[id]/merge";
import aliasesRoute from "@/pages/api/vendors/[id]/aliases";
import vendorsRoute from "@/pages/api/vendors/index";
import { handler as createFromCart } from "@/pages/api/sales/orders/create-from-cart";
import VendorsPage from "@/app/(dashboard)/app/inventory/vendors/page";

type Route = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function call(
  route: Route,
  userId: string,
  {
    method = "GET",
    query = {},
    body = {},
  }: { method?: string; query?: object; body?: object } = {},
): Promise<Reply> {
  (getServerSession as jest.Mock).mockResolvedValue({
    user: { id: userId, email: `${userId}@example.com` },
  });
  let status = 200;
  let payload: unknown = null;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(p: unknown) {
      payload = p;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  } as unknown as NextApiResponse;
  await route({ method, query, body, cookies: {} } as unknown as NextApiRequest, res);
  return { status, body: JSON.parse(JSON.stringify(payload)) };
}

async function makeStaff(userId: string, roleKey: string) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  await prisma.staffMember.create({
    data: {
      userId,
      displayName: userId,
      email: `${userId}@example.com`,
      role: roleKey as never,
      roleId: role.id,
      isActive: true,
    },
  });
}

const preview = (fromId: number, intoId: number, userId = "ada") =>
  call(mergeRoute, userId, { query: { id: String(fromId), into: String(intoId) } });
const merge = (fromId: number, intoId: number, userId = "ada") =>
  call(mergeRoute, userId, { method: "POST", query: { id: String(fromId) }, body: { intoId } });

let dept: { id: number };
let cat: { id: number };

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  clearVendorPrefixCacheForTesting();
  await syncBuiltInRoles({ prisma });
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Co", slug: "test-co" },
  });
  await prisma.appSettings.create({
    data: { organizationId: DEFAULT_ORG_ID, companyName: "Linden Row Home", timezone: "UTC" },
  });
  invalidateAppSettingsCache();
  // An admin on file, so the bootstrap safeguard is off and each refusal is real.
  await makeStaff("ada", "ADMIN");
  await makeStaff("bea", "BUYER");
  await makeStaff("dee", "DESIGNER");
  dept = await prisma.department.create({ data: { name: "Living" } });
  cat = await prisma.category.create({ data: { name: "Seating", departmentId: dept.id } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

const product = (vendorId: number, productNumber: string, extra: object = {}) =>
  prisma.product.create({
    data: {
      productNumber,
      name: productNumber,
      vendorId,
      departmentId: dept.id,
      categoryId: cat.id,
      ...extra,
    },
  });

const vendor = (name: string, extra: object = {}) =>
  prisma.vendor.create({ data: { name, ...extra } });

/** A grade dimension with one tier, which a fabric needs. */
async function gradeTier(vendorId: number, name = "Grade") {
  const dimension = await prisma.vendorPriceDimension.create({
    data: { vendorId, name, dimensionType: "FABRIC_GRADE" },
  });
  return prisma.priceDimensionTier.create({
    data: { dimensionId: dimension.id, name: "Grade A", code: "A" },
  });
}

describe("merging a duplicate vendor", () => {
  it("moves everything filed under the duplicate, keeps its name, and deletes it", async () => {
    const kept = await vendor("Amberlin", {
      email: "orders@amberlin.example.com",
      notes: "Main line",
    });
    const dup = await vendor("Amberlin Furniture", {
      code: "AMF",
      phone: "555-0101",
      website: "amberlin.example.com",
      notes: "Ask for Rita",
      defaultMarkup: 2.2,
    });
    const third = await vendor("Coastline");
    // A collection by the same name on both folds into the kept vendor's.
    const keptBristol = await prisma.collection.create({
      data: { vendorId: kept.id, name: "Bristol" },
    });
    const dupBristol = await prisma.collection.create({
      data: { vendorId: dup.id, name: "Bristol" },
    });
    const harbor = await prisma.collection.create({ data: { vendorId: dup.id, name: "Harbor" } });

    const item = await product(dup.id, "AMF-1", { collectionId: dupBristol.id });
    const contact = await prisma.vendorContact.create({ data: { vendorId: dup.id, name: "Rita" } });
    const prefix = await prisma.vendorNumberPrefix.create({
      data: { vendorId: dup.id, prefix: "AMF-" },
    });
    const style = await prisma.vendorStyle.create({
      data: {
        vendorId: dup.id,
        styleNumber: "S-100",
        name: "Bristol Sofa",
        collectionId: dupBristol.id,
      },
    });
    const list = await prisma.priceList.create({
      data: {
        vendorId: dup.id,
        name: "2026",
        effectiveDate: new Date("2026-01-01"),
        priceType: "COST",
      },
    });
    const tier = await gradeTier(dup.id);
    const fabric = await prisma.fabricCatalog.create({
      data: { vendorId: dup.id, tierId: tier.id, fabricName: "Tweed", colorName: "Blue" },
    });
    const group = await prisma.vendorOptionGroup.create({
      data: { vendorId: dup.id, name: "Legs" },
    });
    const program = await prisma.vendorProgram.create({
      data: { vendorId: dup.id, name: "Stocking" },
    });
    const component = await prisma.sEComponent.create({
      data: { vendorId: dup.id, componentType: "ARM", code: "A", name: "Track arm" },
    });
    const coastItem = await product(third.id, "CL-1");
    const source = await prisma.productSource.create({
      data: { productId: coastItem.id, vendorId: dup.id, itemNumber: "AMF-CL1" },
    });
    const po = await prisma.purchaseOrder.create({
      data: { poNumber: "PO-AMF-1", vendorId: dup.id },
    });
    const draftPo = await prisma.buyerDraftPurchaseOrder.create({
      data: { vendorId: dup.id, vendorName: "Amberlin Furniture" },
    });
    const draftItem = await prisma.buyerDraftItem.create({
      data: {
        vendorId: dup.id,
        vendorName: "Amberlin Furniture",
        partNumber: "AMF-2",
        productName: "Bristol Chair",
        cost: 100,
        retail: 250,
      },
    });
    const [type, status, priority] = await Promise.all([
      prisma.serviceCaseType.create({ data: { name: "Repair" } }),
      prisma.serviceCaseStatus.create({ data: { name: "Open" } }),
      prisma.serviceCasePriority.create({ data: { name: "Normal" } }),
    ]);
    const serviceCase = await prisma.serviceCase.create({
      data: {
        caseNumber: "SC-1",
        typeId: type.id,
        statusId: status.id,
        priorityId: priority.id,
        summary: "Loose arm",
        vendorId: dup.id,
      },
    });
    const receipt = await prisma.consignmentReceipt.create({ data: { vendorId: dup.id } });
    const consigned = await prisma.consignmentItem.create({
      data: { vendorId: dup.id, barcode: "AMF-C1", cost: 300 },
    });
    const batch = await prisma.consignmentPaymentBatch.create({
      data: {
        vendorId: dup.id,
        periodStart: new Date("2026-10-01"),
        periodEnd: new Date("2026-10-31"),
        totalAmount: 300,
      },
    });
    const vendorReturn = await prisma.consignmentVendorReturn.create({
      data: { vendorId: dup.id },
    });
    const definition = await prisma.importDefinition.create({
      data: { name: "Amberlin price file", targetEntity: "product", vendorId: dup.id },
    });
    // An earlier merge into the duplicate: its name follows to the kept vendor.
    const earlier = await prisma.vendorAlias.create({
      data: { name: "AMBERLIN FURN", vendorId: dup.id, mergedVendorId: 999 },
    });

    const r = await merge(dup.id, kept.id);
    expect(r.status).toBe(200);
    expect(r.body.problems).toEqual([]);
    expect(r.body.takes).toEqual(["code", "website", "phone"]);
    expect(
      Object.fromEntries(
        r.body.moves.map((m: { label: string; count: number }) => [m.label, m.count]),
      ),
    ).toEqual({
      item: 1,
      contact: 1,
      "number prefix": 1,
      style: 1,
      collections: 2,
      "price list": 1,
      "price dimension": 1,
      fabric: 1,
      "option group": 1,
      program: 1,
      component: 1,
      "item it sells us besides its own": 1,
      "purchase order": 1,
      "buyer draft order": 1,
      "buyer draft item": 1,
      "service case": 1,
      "consignment receipt": 1,
      "consignment item": 1,
      "consignment payment": 1,
      "consignment return": 1,
      "import definition": 1,
      "earlier name": 1,
    });

    expect(await prisma.vendor.findUnique({ where: { id: dup.id } })).toBeNull();
    const vendorOf = async (
      model: string,
      id: number,
    ): Promise<{ vendorId: number | null; vendorName?: string }> =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (prisma as any)[model].findUniqueOrThrow({ where: { id } });
    for (const [model, row] of [
      ["product", item],
      ["vendorContact", contact],
      ["vendorNumberPrefix", prefix],
      ["vendorStyle", style],
      ["collection", harbor],
      ["priceList", list],
      ["fabricCatalog", fabric],
      ["vendorOptionGroup", group],
      ["vendorProgram", program],
      ["sEComponent", component],
      ["productSource", source],
      ["purchaseOrder", po],
      ["buyerDraftPurchaseOrder", draftPo],
      ["buyerDraftItem", draftItem],
      ["serviceCase", serviceCase],
      ["consignmentReceipt", receipt],
      ["consignmentItem", consigned],
      ["consignmentPaymentBatch", batch],
      ["consignmentVendorReturn", vendorReturn],
      ["importDefinition", definition],
      ["vendorAlias", earlier],
    ] as const) {
      expect([model, (await vendorOf(model, row.id)).vendorId]).toEqual([model, kept.id]);
    }
    // A buyer draft takes the kept vendor's name along with its id.
    expect((await vendorOf("buyerDraftPurchaseOrder", draftPo.id)).vendorName).toBe("Amberlin");
    expect((await vendorOf("buyerDraftItem", draftItem.id)).vendorName).toBe("Amberlin");

    // The same-named collection folded: its item and style moved, and it went.
    expect(await prisma.collection.findUnique({ where: { id: dupBristol.id } })).toBeNull();
    expect((await prisma.product.findUniqueOrThrow({ where: { id: item.id } })).collectionId).toBe(
      keptBristol.id,
    );
    expect(
      (await prisma.vendorStyle.findUniqueOrThrow({ where: { id: style.id } })).collectionId,
    ).toBe(keptBristol.id);

    // The kept vendor takes what it lacked and keeps its own details and pricing.
    const after = await prisma.vendor.findUniqueOrThrow({ where: { id: kept.id } });
    expect(after).toMatchObject({
      code: "AMF",
      phone: "555-0101",
      website: "amberlin.example.com",
      email: "orders@amberlin.example.com",
      notes: "Main line\n\nFrom Amberlin Furniture: Ask for Rita",
      defaultMarkup: null,
      updatedBy: "ada@example.com",
    });

    const alias = await prisma.vendorAlias.findUniqueOrThrow({
      where: { name: "Amberlin Furniture" },
    });
    expect(alias).toMatchObject({
      vendorId: kept.id,
      mergedVendorId: dup.id,
      createdBy: "ada@example.com",
    });
  });

  it("previews what a merge would do and writes nothing", async () => {
    const kept = await vendor("Amberlin");
    const dup = await vendor("Amberlin Furniture", { phone: "555-0101" });
    await product(dup.id, "AMF-1");
    await product(dup.id, "AMF-2");

    const r = await preview(dup.id, kept.id);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      from: { id: dup.id, name: "Amberlin Furniture" },
      into: { id: kept.id, name: "Amberlin" },
      moves: [{ label: "items", count: 2 }],
      takes: ["phone"],
      problems: [],
    });
    expect(await prisma.vendor.findUnique({ where: { id: dup.id } })).not.toBeNull();
    expect(await prisma.product.count({ where: { vendorId: dup.id } })).toBe(2);
    expect(await prisma.vendorAlias.count()).toBe(0);
  });

  it("refuses when both hold a record kept once per vendor, naming each, and changes nothing", async () => {
    const kept = await vendor("Oakline");
    const dup = await vendor("Oakline Inc");
    const third = await vendor("Coastline");
    for (const v of [kept, dup]) {
      for (const n of [1, 2, 3, 4, 5, 6, 7]) {
        await prisma.vendorStyle.create({
          data: { vendorId: v.id, styleNumber: `S-${n}`, name: `Style ${n}` },
        });
      }
      await prisma.priceList.create({
        data: {
          vendorId: v.id,
          name: "2026",
          effectiveDate: new Date("2026-01-01"),
          priceType: "COST",
        },
      });
      const tier = await gradeTier(v.id);
      await prisma.fabricCatalog.create({
        data: { vendorId: v.id, tierId: tier.id, fabricName: "Tweed", colorName: "Blue" },
      });
      await prisma.vendorOptionGroup.create({ data: { vendorId: v.id, name: "Legs" } });
      await prisma.vendorProgram.create({ data: { vendorId: v.id, name: "Stocking" } });
      await prisma.sEComponent.create({
        data: { vendorId: v.id, componentType: "ARM", code: "A", name: "Track arm" },
      });
    }
    // A fabric whose name and colour only run together the same doesn't clash.
    const dupTier = await prisma.priceDimensionTier.findFirstOrThrow({
      where: { dimension: { vendorId: dup.id } },
    });
    await prisma.fabricCatalog.create({
      data: { vendorId: dup.id, tierId: dupTier.id, fabricName: "Tweed Blue", colorName: "" },
    });
    // An item listing both as other vendors, and items that would list the kept
    // vendor as both their own and another.
    const listsBoth = await product(third.id, "CL-BOTH");
    await prisma.productSource.createMany({
      data: [
        { productId: listsBoth.id, vendorId: kept.id },
        { productId: listsBoth.id, vendorId: dup.id },
      ],
    });
    const keptItem = await product(kept.id, "OAK-1", { name: "Oak Bench" });
    await prisma.productSource.create({ data: { productId: keptItem.id, vendorId: dup.id } });
    const dupItem = await product(dup.id, "OAK-2", { name: "Oak Table" });
    await prisma.productSource.create({ data: { productId: dupItem.id, vendorId: kept.id } });

    const r = await merge(dup.id, kept.id);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("Oakline Inc can't be merged into Oakline yet.");
    expect(r.body.problems).toEqual([
      "Both have styles S-1, S-2, S-3, S-4, S-5 and 2 more.",
      "Both have a price list named 2026.",
      "Both have a price dimension named Grade.",
      "Both have the fabric Tweed in Blue.",
      "Both have an option group named Legs.",
      "Both have a program named Stocking.",
      "Both have the component ARM A.",
      "CL-BOTH lists both as other vendors.",
      "Oak Bench and Oak Table would list Oakline as both their own vendor and another.",
    ]);
    // The preview says the same.
    expect((await preview(dup.id, kept.id)).body.problems).toEqual(r.body.problems);
    // Nothing moved.
    expect(await prisma.vendor.findUnique({ where: { id: dup.id } })).not.toBeNull();
    expect(await prisma.vendorStyle.count({ where: { vendorId: dup.id } })).toBe(7);
    expect(await prisma.vendorAlias.count()).toBe(0);
  });

  it("refuses a consignment vendor and one that isn't", async () => {
    const kept = await vendor("Tidewater Rugs", { isConsignment: true });
    const dup = await vendor("Tidewater");
    const r = await merge(dup.id, kept.id);
    expect(r.status).toBe(409);
    expect(r.body.problems).toEqual([
      "Tidewater Rugs takes goods on consignment and Tidewater doesn't, so their items are owned and paid for differently.",
    ]);
  });

  it("refuses while a commission rule names the duplicate, and not for one naming the kept vendor", async () => {
    const kept = await vendor("Amberlin");
    const dup = await vendor("Amberlin Furniture");
    const plan = await prisma.commissionPlan.create({ data: { name: "Floor staff" } });
    await prisma.commissionPlanRule.create({
      data: { planId: plan.id, label: "Amberlin bonus", vendorId: kept.id, sortOrder: 1 },
    });
    const rule = await prisma.commissionPlanRule.create({
      data: { planId: plan.id, label: "Amberlin Furniture spiff", vendorId: dup.id, sortOrder: 2 },
    });

    const r = await merge(dup.id, kept.id);
    expect(r.status).toBe(409);
    expect(r.body.problems).toEqual([
      'A commission rule is for Amberlin Furniture: "Amberlin Furniture spiff" in Floor staff. Change or remove it first, so the merge doesn\'t change what anyone earns.',
    ]);

    await prisma.commissionPlanRule.delete({ where: { id: rule.id } });
    expect((await merge(dup.id, kept.id)).status).toBe(200);
  });

  it("refuses a vendor merged into itself, a missing vendor, and no choice", async () => {
    const kept = await vendor("Amberlin");
    expect(await merge(kept.id, kept.id)).toEqual({
      status: 400,
      body: { error: "Choose a different vendor to merge into.", problems: [] },
    });
    expect((await merge(kept.id, 999999)).body.error).toBe(
      "The vendor to merge into doesn't exist.",
    );
    expect((await merge(kept.id, 999999)).status).toBe(404);
    expect((await preview(999999, kept.id)).status).toBe(404);
    const none = await call(mergeRoute, "ada", { method: "POST", query: { id: String(kept.id) } });
    expect(none).toEqual({
      status: 400,
      body: { error: "Choose a vendor to merge into.", problems: [] },
    });
  });

  it("keeps a chain flat: merging the kept vendor on takes its earlier names with it", async () => {
    const a = await vendor("Amberlin Furn");
    const b = await vendor("Amberlin Furniture");
    const c = await vendor("Amberlin");
    expect((await merge(a.id, b.id)).status).toBe(200);
    expect((await merge(b.id, c.id)).status).toBe(200);
    const aliases = await prisma.vendorAlias.findMany({ orderBy: { name: "asc" } });
    expect(aliases.map((x) => [x.name, x.vendorId, x.mergedVendorId])).toEqual([
      ["Amberlin Furn", c.id, a.id],
      ["Amberlin Furniture", c.id, b.id],
    ]);
  });

  it("is admin.data only, preview included", async () => {
    const kept = await vendor("Amberlin");
    const dup = await vendor("Amberlin Furniture");
    expect((await preview(dup.id, kept.id, "bea")).status).toBe(403);
    expect((await merge(dup.id, kept.id, "bea")).status).toBe(403);
    expect(await prisma.vendor.findUnique({ where: { id: dup.id } })).not.toBeNull();
  });

  it("the vendors page lets an admin merge and nobody else", async () => {
    async function viewProps(userId: string) {
      (getToken as jest.Mock).mockResolvedValue({ id: userId });
      (headers as jest.Mock).mockResolvedValue(new Headers());
      (cookies as jest.Mock).mockResolvedValue({ getAll: () => [], get: () => undefined });
      const element = await VendorsPage();
      return element.props;
    }
    expect(await viewProps("ada")).toEqual({ canMerge: true });
    expect(await viewProps("bea")).toEqual({ canMerge: false });
  });

  it("refuses a blank earlier name in the database", async () => {
    const kept = await vendor("Amberlin");
    await expect(
      prisma.vendorAlias.create({ data: { name: "  ", vendorId: kept.id, mergedVendorId: 1 } }),
    ).rejects.toThrow(/VendorAlias_name_not_blank/);
  });
});

describe("finding a vendor by name after a merge", () => {
  async function merged() {
    const kept = await vendor("Amberlin");
    const dup = await vendor("Amberlin Furniture");
    await mergeVendor(prisma, dup.id, kept.id, "ada@example.com");
    return kept;
  }

  it("finds the kept vendor by the earlier name, exactly or ignoring case", async () => {
    const kept = await merged();
    expect(await findVendorByName(prisma, "Amberlin Furniture")).toEqual({
      id: kept.id,
      name: "Amberlin",
      alias: "Amberlin Furniture",
    });
    expect(await findVendorByName(prisma, "AMBERLIN FURNITURE")).toBeNull();
    expect(await vendorIdByName(prisma, "AMBERLIN FURNITURE", { ignoreCase: true })).toBe(kept.id);
    expect(await findVendorByName(prisma, "Amberlin")).toEqual({
      id: kept.id,
      name: "Amberlin",
      alias: null,
    });
  });

  it("prefers a vendor's own name to an earlier one, and an exact match to one ignoring case", async () => {
    const kept = await merged();
    const delmar = await vendor("Amberlin furniture");
    // A vendor really named so wins over the earlier name that lowercases the same.
    expect(await vendorIdByName(prisma, "AMBERLIN FURNITURE", { ignoreCase: true })).toBe(
      delmar.id,
    );
    expect(await vendorIdByName(prisma, "Amberlin Furniture", { ignoreCase: true })).toBe(
      delmar.id,
    );
    expect(await vendorIdByName(prisma, "Amberlin Furniture")).toBe(kept.id);
    const shout = await vendor("AMBERLIN");
    expect(await vendorIdByName(prisma, "AMBERLIN", { ignoreCase: true })).toBe(shout.id);
    expect(await vendorIdByName(prisma, "amberlin", { ignoreCase: true })).toBe(kept.id);
    const index = await vendorNameIndex(prisma);
    expect(index.get("amberlin furniture")).toBe(delmar.id);
  });

  it("indexes earlier names, and a vendor made from the index goes into it", async () => {
    const kept = await merged();
    const index = await vendorNameIndex(prisma);
    expect(index.get("amberlin furniture")).toBe(kept.id);
    expect(await findOrCreateInIndex(prisma, index, "AMBERLIN FURNITURE")).toBe(kept.id);
    const harbor = await findOrCreateInIndex(prisma, index, "Harbor Lighting", {
      pricingModel: "FLAT",
    });
    expect(await findOrCreateInIndex(prisma, index, "harbor lighting")).toBe(harbor);
    expect(await prisma.vendor.count({ where: { name: { startsWith: "Harbor" } } })).toBe(1);
  });

  it("the vendor screen refuses an earlier name or a duplicate, and finds a vendor by its earlier name", async () => {
    const kept = await merged();
    expect(
      await call(vendorsRoute, "bea", { method: "POST", body: { name: " Amberlin Furniture " } }),
    ).toEqual({
      status: 409,
      body: { error: "Amberlin Furniture was merged into Amberlin. Use Amberlin." },
    });
    expect(await call(vendorsRoute, "bea", { method: "POST", body: { name: "amberlin" } })).toEqual(
      {
        status: 409,
        body: { error: "A vendor named Amberlin already exists." },
      },
    );
    expect(
      (await call(vendorsRoute, "bea", { method: "POST", body: { name: "Harbor Lighting" } }))
        .status,
    ).toBe(201);
    const found = await call(vendorsRoute, "bea", { query: { search: "furniture" } });
    expect(found.body.vendors.map((v: { id: number }) => v.id)).toEqual([kept.id]);
  });

  it("lists earlier names for a catalog reader; only admin.data forgets one, and then the name is free", async () => {
    const kept = await merged();
    const listed = await call(aliasesRoute, "dee", { query: { id: String(kept.id) } });
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      expect.objectContaining({ name: "Amberlin Furniture", createdBy: "ada@example.com" }),
    ]);
    const aliasId = String(listed.body[0].id);
    expect(
      (
        await call(aliasesRoute, "bea", {
          method: "DELETE",
          query: { id: String(kept.id), aliasId },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(aliasesRoute, "ada", { method: "DELETE", query: { id: "999999", aliasId } }))
        .status,
    ).toBe(404);
    expect(
      (
        await call(aliasesRoute, "ada", {
          method: "DELETE",
          query: { id: String(kept.id), aliasId },
        })
      ).status,
    ).toBe(204);
    expect(await findVendorByName(prisma, "Amberlin Furniture")).toBeNull();
    expect(
      (await call(vendorsRoute, "bea", { method: "POST", body: { name: "Amberlin Furniture" } }))
        .status,
    ).toBe(201);
  });
});

describe("imports find a merged vendor by its earlier name", () => {
  async function merged(extra: object = {}) {
    const kept = await vendor("Amberlin", extra);
    const dup = await vendor("Amberlin Furniture", extra);
    await mergeVendor(prisma, dup.id, kept.id, null);
    return kept;
  }

  it("the vendor import updates the kept vendor rather than making the old one again", async () => {
    const kept = await merged();
    const result = await runGenericImport(
      "vendor",
      { name: "Vendor", phone: "Phone" },
      [{ Vendor: "Amberlin Furniture", Phone: "555-0199" }],
      "ada@example.com",
    );
    expect(result).toMatchObject({ imported: 1, errors: [] });
    expect(await prisma.vendor.count()).toBe(1);
    expect((await prisma.vendor.findUniqueOrThrow({ where: { id: kept.id } })).phone).toBe(
      "555-0199",
    );
  });

  it("the product import files an item under the kept vendor", async () => {
    const kept = await merged();
    const result = await runGenericImport(
      "product",
      {
        productNumber: "Part",
        name: "Name",
        vendor: "Vendor",
        department: "Dept",
        category: "Cat",
      },
      [
        {
          Part: "AMF-9",
          Name: "Bristol Ottoman",
          Vendor: "AMBERLIN FURNITURE",
          Dept: "Living",
          Cat: "Seating",
        },
      ],
      "ada@example.com",
    );
    expect(result.errors).toEqual([]);
    const item = await prisma.product.findFirstOrThrow({ where: { productNumber: "AMF-9" } });
    expect(item.vendorId).toBe(kept.id);
    expect(await prisma.vendor.count()).toBe(1);
  });

  it("the Ordorite PO import orders from the kept vendor and still pays its consignment", async () => {
    const kept = await merged({ isConsignment: true });
    await prisma.vendorNumberPrefix.create({ data: { vendorId: kept.id, prefix: "AMF-" } });
    clearVendorPrefixCacheForTesting();
    await prisma.consignmentItem.create({
      data: {
        vendorId: kept.id,
        barcode: "AMF-1001",
        customerNumber: "1001",
        cost: 300,
        status: "SOLD",
      },
    });
    const result = await runPurchaseOrdersImport([
      {
        Pono: "PO-T1",
        Porno: "POR-T1",
        Supplier: "Amberlin Furniture",
        Postatus: "Received",
        "Part No": "AMF-1001",
        Qty: 1,
        "Supplier Cost": 300,
        Product_name: "Hand-knotted rug",
      },
    ]);
    expect(result.errors).toEqual([]);
    expect(
      (await prisma.purchaseOrder.findUniqueOrThrow({ where: { poNumber: "PO-T1" } })).vendorId,
    ).toBe(kept.id);
    expect(await prisma.vendor.count()).toBe(1);
    expect(result.consignmentBatchesCreated).toBe(1);
  });

  it("the Ordorite Unknown Vendor follows a merge rather than pointing at a deleted vendor", async () => {
    const first = await ensureUnknownVendorId(prisma);
    const unknown = await vendor("Unknown");
    await mergeVendor(prisma, first, unknown.id, null);
    expect(await ensureUnknownVendorId(prisma)).toBe(unknown.id);
  });

  it("the POS cart files a custom line under the kept vendor, and makes a new vendor once", async () => {
    const kept = await merged();
    const store = await prisma.storeLocation.create({
      data: { name: "Test Store", code: "TS", type: "STORE" },
    });
    let statusCode = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let body: any;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(p: unknown) {
        body = p;
        return this;
      },
      setHeader() {
        return this;
      },
      end() {
        return this;
      },
    } as unknown as NextApiResponse;
    const line = (name: string, vendorName: string) => ({
      type: "CUSTOM",
      name,
      vendor: vendorName,
      quantity: 1,
      unitPrice: 100,
    });
    await createFromCart(
      {
        method: "POST",
        query: {},
        cookies: {},
        headers: {},
        body: {
          storeLocation: store.name,
          items: [
            line("Bristol pillow", "Amberlin Furniture"),
            line("Brass sconce", "Harbor Lighting"),
            line("Brass lamp", "harbor lighting"),
          ],
        },
      } as unknown as NextApiRequest,
      res,
      { user: { email: "dee@example.com" } } as unknown as Session,
      { holds: {} } as never,
    );
    expect([statusCode, body?.error]).toEqual([201, undefined]);
    const pillow = await prisma.product.findFirstOrThrow({ where: { name: "Bristol pillow" } });
    expect(pillow.vendorId).toBe(kept.id);
    const harbors = await prisma.vendor.findMany({
      where: { name: { startsWith: "Harbor", mode: "insensitive" } },
    });
    expect(harbors).toHaveLength(1);
    const lamps = await prisma.product.findMany({ where: { name: { startsWith: "Brass" } } });
    expect(lamps.map((p) => p.vendorId)).toEqual([harbors[0].id, harbors[0].id]);
  });
});
