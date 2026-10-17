// /app/__tests__/integration/specialOrderLeadTime.integration.test.ts
//
// A special order's PO is dated by the vendor's standard lead time.
//
// The first payment on an order raises a draft PO per vendor for its special-
// order lines (lib/paymentService.ts onPaymentReceived). Those POs carried no
// expected date, so nothing could say which were late. They now take order date
// + Vendor.leadTimeDays -- and a vendor nobody has given a lead time gets no
// date at all, never a guessed one.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { onPaymentReceived } from "@/lib/paymentService";

const DAY_MS = 86_400_000;

async function seedSpecialOrder() {
  const dept = await prisma.department.create({ data: { name: "Living" } });
  const cat = await prisma.category.create({ data: { name: "Sofas", departmentId: dept.id } });
  const known = await prisma.vendor.create({
    data: { name: "Known Lead", pricingModel: "FLAT", leadTimeDays: 56 },
  });
  const unknown = await prisma.vendor.create({ data: { name: "No Lead", pricingModel: "FLAT" } });
  const product = (vendorId: number, n: string) =>
    prisma.product.create({
      data: { productNumber: n, name: n, vendorId, departmentId: dept.id, categoryId: cat.id },
    });
  const sofa = await product(known.id, "SOFA-1");
  const chair = await product(unknown.id, "CHAIR-1");

  const order = await prisma.salesOrder.create({
    data: {
      orderno: "SO-LEAD-1",
      status: "QUOTE",
      orderDate: new Date(),
      lineItems: {
        create: [sofa, chair].map((p, i) => ({
          lineNumber: i + 1,
          productId: p.id,
          productName: p.name,
          orderedQuantity: 1,
          netPrice: 1000,
          cost: 450,
          vatRate: 0,
          vatAmount: 0,
          source: "ORDER" as const,
        })),
      },
    },
  });
  return { order, known, unknown };
}

describe("special-order POs are dated by vendor lead time (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("expects the goods lead-time days after the PO is raised", async () => {
    const { order, known } = await seedSpecialOrder();
    const before = Date.now();

    await onPaymentReceived(order.id);

    const po = await prisma.purchaseOrder.findFirstOrThrow({
      where: { salesOrderId: order.id, vendorId: known.id },
    });
    expect(po.expectedDelivery).not.toBeNull();
    const days = (po.expectedDelivery!.getTime() - po.orderDate.getTime()) / DAY_MS;
    expect(days).toBe(56);
    expect(po.orderDate.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("leaves the date empty for a vendor with no lead time on file", async () => {
    const { order, unknown } = await seedSpecialOrder();

    await onPaymentReceived(order.id);

    const po = await prisma.purchaseOrder.findFirstOrThrow({
      where: { salesOrderId: order.id, vendorId: unknown.id },
    });
    expect(po.expectedDelivery).toBeNull();
  });
});
