// app/prisma/seed/demo/consignment.ts
//
// A GENERIC consignment vendor (never a real dealer — see names.ts) with
// receipts, items across the real status lifecycle, and a payment batch.
// Reuses the real `calculateRugPricing()` pricing rule from
// lib/consignment.ts (anchorPrice = cost * 7, retailPrice = anchorPrice /
// 2) instead of inventing a different markup here.

import type { ConsignmentItemStatus, PrismaClient } from "@prisma/client";
import { calculateRugPricing } from "@/lib/consignment";
import type { Rng } from "./rng";
import { pick, randFloat, randInt, round2, subRng, weightedPick } from "./rng";
import { CONSIGNMENT_VENDOR_CODE, CONSIGNMENT_VENDOR_NAME } from "./names";
import type { StoreSetup } from "./locations";

const SEED_ACTOR = "seed:demo";

const QUALITIES = ["Hand-Knotted", "Hand-Tufted", "Flatweave", "Antique Wash"] as const;
const SIZES = ["5x8", "6x9", "8x10", "9x12", "10x14", "Runner 2.5x12"] as const;

const STATUS_MIX: readonly (readonly [ConsignmentItemStatus, number])[] = [
  ["ON_FLOOR", 55],
  ["SOLD", 18],
  ["PAID", 15],
  ["ON_APPROVAL", 6],
  ["RETURNED_VENDOR", 4],
  ["MISSING", 2],
];

export interface ConsignmentResult {
  vendorId: number;
  itemsCreated: number;
  paymentBatchId: number;
}

export async function seedConsignment(
  prisma: PrismaClient,
  rng: Rng,
  window: { start: Date; end: Date },
  stores: readonly StoreSetup[],
  itemCount: number,
): Promise<ConsignmentResult> {
  const cRng = subRng(rng, "consignment");

  const vendor = await prisma.vendor.upsert({
    where: { name: CONSIGNMENT_VENDOR_NAME },
    update: { isConsignment: true },
    create: {
      isConsignment: true,
      name: CONSIGNMENT_VENDOR_NAME,
      code: CONSIGNMENT_VENDOR_CODE,
      pricingModel: "FLAT",
      paymentTerms: "Consignment — paid on sale, net of commission",
      city: "Wintergreen Harbor",
      state: "CT",
      notes: "Generic invented consignment-rug source used for seed/demo data only.",
      createdBy: SEED_ACTOR,
    },
  });

  // How this vendor's numbers look, so a tag or product number resolves back to
  // it. The seed's items are barcoded "ATR-1000", so the prefix is "ATR-".
  //
  // Seeded because the feature is OPT-IN and invisible without a row: a
  // deployment with none has vendor-number resolution off entirely, and the
  // consignment screens would demo as though the capability did not exist.
  await prisma.vendorNumberPrefix.upsert({
    where: { prefix: "ATR-" },
    update: {},
    create: {
      vendorId: vendor.id,
      prefix: "ATR-",
      barcodePrefix: "A",
      note: "Demo consignment vendor: POS numbers read ATR-1000, tags read A1000.",
      createdBy: SEED_ACTOR,
    },
  });

  const receipt = await prisma.consignmentReceipt.create({
    data: {
      vendorId: vendor.id,
      receiptDate: window.start,
      manifestRef: "SEED-MANIFEST-0001",
      itemCount,
      notes: "Synthetic consignment manifest for demo/test data.",
      createdBy: SEED_ACTOR,
    },
  });

  const batchStart = new Date(window.start.getTime() + 30 * 86_400_000);
  const batchEnd = new Date(batchStart.getTime() + 30 * 86_400_000);
  const batch = await prisma.consignmentPaymentBatch.create({
    data: {
      vendorId: vendor.id,
      batchDate: batchEnd,
      periodStart: batchStart,
      periodEnd: batchEnd,
      checkNumber: `CHK-${randInt(cRng, 10000, 99999)}`,
      totalAmount: 0, // updated below once PAID items are known
      itemCount: 0,
      isPaid: true,
      createdBy: SEED_ACTOR,
    },
  });

  let itemsCreated = 0;
  let batchTotal = 0;
  let batchCount = 0;

  for (let i = 0; i < itemCount; i++) {
    const cost = round2(randFloat(cRng, 180, 2200));
    const { anchorPrice, retailPrice } = calculateRugPricing(cost);
    const status = weightedPick(cRng, STATUS_MIX);
    const store = pick(cRng, stores);
    const barcode = `ATR-${1000 + i}`;
    const receivedDate = new Date(window.start.getTime() + randInt(cRng, 0, 45) * 86_400_000);

    const isSold = status === "SOLD" || status === "PAID";
    const isPaid = status === "PAID";

    await prisma.consignmentItem.create({
      data: {
        vendorId: vendor.id,
        barcode,
        rugNumber: `RUG-${2000 + i}`,
        customerNumber: `${randInt(cRng, 1000, 9999)}-${randInt(cRng, 10, 99)}`,
        quality: pick(cRng, QUALITIES),
        size: pick(cRng, SIZES),
        cost,
        anchorPrice,
        retailPrice,
        sellingPrice: isSold ? round2(retailPrice * (0.85 + cRng() * 0.15)) : null,
        status,
        year: receivedDate.getUTCFullYear(),
        consignmentReceiptId: receipt.id,
        receivedDate,
        storeLocationId: store.id,
        saleDate: isSold
          ? new Date(receivedDate.getTime() + randInt(cRng, 5, 120) * 86_400_000)
          : null,
        saleTransactionId: isSold ? `SEED-SALE-${1000 + i}` : null,
        onApprovalDate: status === "ON_APPROVAL" ? receivedDate : null,
        returnedDate: status === "RETURNED_VENDOR" ? receivedDate : null,
        returnReason:
          status === "RETURNED_VENDOR"
            ? "Customer never claimed; returned to vendor per terms."
            : null,
        consignmentPaymentBatchId: isPaid ? batch.id : null,
        paidDate: isPaid ? batchEnd : null,
        createdBy: SEED_ACTOR,
      },
    });
    itemsCreated += 1;
    if (isPaid) {
      batchTotal = round2(batchTotal + Number(round2(cost * 0.6))); // consignor payout ~60% of cost basis
      batchCount += 1;
    }
  }

  await prisma.consignmentPaymentBatch.update({
    where: { id: batch.id },
    data: { totalAmount: batchTotal, itemCount: batchCount },
  });

  return { vendorId: vendor.id, itemsCreated, paymentBatchId: batch.id };
}
