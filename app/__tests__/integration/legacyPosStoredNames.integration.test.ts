// /app/__tests__/integration/legacyPosStoredNames.integration.test.ts
//
// Two names the adapter's code no longer uses but a deployment's data still
// does. Both literals are repeated here on purpose: a test that read them from
// storedNames.ts would keep passing if someone "tidied" the value, which is the
// change that loses the data.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { hasOrderFlag, SKIP_SAME_DAY_REWRITE_CLEANUP } from "@/lib/adapters/legacyPos/orderFlags";
import { runProductsImport } from "@/lib/adapters/legacyPos/runners";

describe("names a deployment's data already holds", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("finds an operator's override stored under the adapter's id", async () => {
    const order = await prisma.salesOrder.create({
      data: { orderno: "STORED-KEY-1", status: "ORDER" },
    });
    expect(await hasOrderFlag(prisma, order.id, SKIP_SAME_DAY_REWRITE_CLEANUP)).toBe(false);

    // The row as a deployed database holds it, written without this adapter's code.
    await prisma.adapterOrderFlag.create({
      data: {
        salesOrderId: order.id,
        adapter: "ordorite",
        flag: SKIP_SAME_DAY_REWRITE_CLEANUP,
        value: true,
      },
    });

    expect(await hasOrderFlag(prisma, order.id, SKIP_SAME_DAY_REWRITE_CLEANUP)).toBe(true);
  });

  it("imports an item row whose id column has the POS's own header", async () => {
    const result = await runProductsImport([
      {
        Active: "yes",
        OrdoriteID: "100077",
        "Part No": "STORED-COLUMN-1",
        "Product Name": "Stored column",
        Department: "Furniture",
        Category: "Sofas",
        Supplier: "Larkmoor Leatherworks",
        "Selling Price": "1000.00",
        "Purchasing Cost": "500.00",
      },
    ]);

    expect(result.errors).toEqual([]);
    const product = await prisma.product.findFirst({ where: { externalId: 100077 } });
    expect(product?.productNumber).toBe("STORED-COLUMN-1");
  });
});
