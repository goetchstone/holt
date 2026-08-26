// /app/prisma/seed/demo/setupData.ts
//
// The configuration tables behind Admin -> Setup.
//
// Every one of these rendered an empty table with column headers and a "No
// results found" row, which is the worst kind of empty: the screen looks built
// and broken at the same time. Two of them are worse than cosmetic -- an
// absent GiftCardPreset dead-ends the gift-card sale flow entirely, and an
// absent LabelTemplate breaks tag printing off a PO receipt.
//
// These are deployment CONFIGURATION rather than transactional data: a real
// store sets them once and edits them rarely. That is exactly why they were
// missed -- nothing generates them, somebody types them in -- and exactly why
// a demo has to ship them, because a viewer will not type them in either.

import type { PrismaClient } from "@prisma/client";
import type { Rng } from "./rng";
import { randInt, subRng } from "./rng";
import type { StaffSetup } from "./staff";
import type { StoreSetup } from "./locations";

const SEED_ACTOR = "seed:demo";

/** The quick codes a cashier types at the register. */
const GIFT_CARD_PRESETS = [
  { code: "GC", label: "Custom Amount", amount: null, sortOrder: 0 },
  { code: "GC25", label: "$25 Gift Card", amount: 25, sortOrder: 1 },
  { code: "GC50", label: "$50 Gift Card", amount: 50, sortOrder: 2 },
  { code: "GC100", label: "$100 Gift Card", amount: 100, sortOrder: 3 },
  { code: "GC250", label: "$250 Gift Card", amount: 250, sortOrder: 4 },
  { code: "GC500", label: "$500 Gift Card", amount: 500, sortOrder: 5 },
];

const TRADE_TIERS = [
  { name: "Designer", discountPercent: 20, sortOrder: 0 },
  { name: "Trade Preferred", discountPercent: 25, sortOrder: 1 },
  { name: "Hospitality / Contract", discountPercent: 30, sortOrder: 2 },
];

const EMAIL_TEMPLATES = [
  {
    name: "Order confirmation",
    category: "SALES",
    subject: "Your order {{orderNumber}} is confirmed",
    body: "Thank you {{customerName}} — we have your order and will be in touch to arrange delivery.",
  },
  {
    name: "Delivery scheduled",
    category: "DISPATCH",
    subject: "Your delivery is booked for {{deliveryDate}}",
    body: "Hello {{customerName}}, your delivery is booked for {{deliveryDate}}. Someone over 18 needs to be home to sign.",
  },
  {
    name: "Ready for collection",
    category: "DISPATCH",
    subject: "{{orderNumber}} is ready to collect",
    body: "Hello {{customerName}}, your order is ready at {{storeName}}. Please bring photo ID.",
  },
  {
    name: "Balance due before delivery",
    category: "BILLING",
    subject: "Balance due on {{orderNumber}}",
    body: "Hello {{customerName}}, the balance of {{balanceDue}} is due before we can schedule your delivery.",
  },
  {
    name: "Service case update",
    category: "SERVICE",
    subject: "Update on your service case {{caseNumber}}",
    body: "Hello {{customerName}}, an update on {{caseNumber}}: {{updateText}}",
  },
  {
    name: "Quote follow-up",
    category: "SALES",
    subject: "Still thinking it over?",
    body: "Hello {{customerName}}, your quote {{quoteNumber}} is still open. Happy to hold the pricing or answer anything.",
  },
];

/**
 * ZPL, because that is what the tag printers in the warehouse speak. Kept
 * deliberately minimal -- a real deployment tunes these to its own stock.
 */
const LABEL_TEMPLATES = [
  {
    name: "Product tag 4x6",
    context: "PRODUCT",
    tagSize: "4x6",
    zplTemplate:
      "^XA^CF0,40^FO30,30^FD{{productName}}^FS^CF0,28^FO30,90^FD{{partNo}}^FS^FO30,140^BY3^BCN,80,Y,N,N^FD{{barcode}}^FS^CF0,32^FO30,260^FD{{retailPrice}}^FS^XZ",
  },
  {
    name: "Receiving tag 2x4",
    context: "RECEIVING",
    tagSize: "2x4",
    zplTemplate:
      "^XA^CF0,28^FO20,20^FD{{poNumber}}^FS^FO20,60^FD{{productName}}^FS^FO20,100^BY2^BCN,50,Y,N,N^FD{{barcode}}^FS^XZ",
  },
  {
    name: "Bin location 2x4",
    context: "LOCATION",
    tagSize: "2x4",
    zplTemplate: "^XA^CF0,44^FO20,25^FD{{locationCode}}^FS^CF0,24^FO20,85^FD{{locationName}}^FS^XZ",
  },
];

export interface SetupDataResult {
  giftCardPresets: number;
  tradeTiers: number;
  emailTemplates: number;
  labelTemplates: number;
  salesGoals: number;
  upBoardEntries: number;
  trafficDays: number;
}

export async function seedSetupData(
  prisma: PrismaClient,
  rng: Rng,
  staff: StaffSetup,
  stores: StoreSetup[],
  today: Date,
): Promise<SetupDataResult> {
  const sRng = subRng(rng, "setup-data");
  const result: SetupDataResult = {
    giftCardPresets: 0,
    tradeTiers: 0,
    emailTemplates: 0,
    labelTemplates: 0,
    salesGoals: 0,
    upBoardEntries: 0,
    trafficDays: 0,
  };

  for (const preset of GIFT_CARD_PRESETS) {
    await prisma.giftCardPreset.create({
      data: { ...preset, isActive: true, createdBy: SEED_ACTOR },
    });
    result.giftCardPresets += 1;
  }

  for (const tier of TRADE_TIERS) {
    await prisma.tradeTier.create({ data: { ...tier, isActive: true } });
    result.tradeTiers += 1;
  }

  for (const t of EMAIL_TEMPLATES) {
    await prisma.emailTemplate.create({ data: { ...t, createdBy: SEED_ACTOR } });
    result.emailTemplates += 1;
  }

  for (const t of LABEL_TEMPLATES) {
    await prisma.labelTemplate.create({ data: { ...t, createdBy: SEED_ACTOR } });
    result.labelTemplates += 1;
  }

  // ---- sales goals -------------------------------------------------------
  // The commission tier ladder and the goals screen both read these. A goal
  // per designer for the current year; without them every progress bar is
  // against zero, which renders as either empty or infinite depending on the
  // screen.
  const fiscalYear = today.getUTCFullYear();
  for (const designer of staff.designers) {
    await prisma.salesGoal.create({
      data: {
        staffMemberId: designer.id,
        fiscalYear,
        yearlyGoal: randInt(sRng, 240, 600) * 1000,
        createdBy: SEED_ACTOR,
      },
    });
    result.salesGoals += 1;
  }

  // ---- the up board -----------------------------------------------------
  // "Designer Rotation" on the dashboard read "No one signed in" for every
  // store. That board is UpBoardEntry, which is a different thing from
  // CustomerInteraction: an interaction is a conversation that happened, an
  // up-board entry is who is on the floor right now and whose turn it is.
  //
  // Each store gets a rotation with one designer actually next up, one with a
  // customer, and one on a break -- because a board where everyone is simply
  // AVAILABLE cannot show that it is a rotation.
  const boardStatuses = ["UP", "WITH_CUSTOMER", "AVAILABLE", "ON_BREAK", "AVAILABLE"] as const;
  for (const store of stores) {
    const onFloor = staff.designers.filter((d) => d.isActive).slice(0, boardStatuses.length);
    for (const [i, designer] of onFloor.entries()) {
      const status = boardStatuses[i];
      await prisma.upBoardEntry.create({
        data: {
          staffMemberId: designer.id,
          storeLocation: store.name,
          storeLocationId: store.id,
          position: i + 1,
          status,
          statusSince: new Date(today.getTime() - randInt(sRng, 5, 180) * 60_000),
          customerNote: status === "WITH_CUSTOMER" ? "Walk-in, looking at sectionals" : null,
        },
      });
      result.upBoardEntries += 1;
    }
  }

  // ---- door-counter traffic ---------------------------------------------
  // The FIRST screen after login is the dashboard, and every store card read
  // "0 Entries Today, 0 LY, 0 In Store". Traffic normally arrives from a
  // third-party door counter over its own API, which cannot be called in a
  // demo -- so it is seeded, which is the honest alternative to a live call.
  //
  // Two years of daily snapshots, because the dashboard compares against the
  // same day last year and a single year makes that comparison read zero.
  // Weekends are busier and Mondays are quiet, so the trend line looks like a
  // shop rather than noise.
  // Built in memory and inserted with createMany: this is ~11,700 rows, and one
  // insert each turns a two-second step into a two-minute one. A seed nobody
  // wants to run is a seed that goes stale.
  const HOURS = [10, 11, 12, 13, 14, 15, 16, 17];
  const snapshots: {
    intervalStart: Date;
    sourceStoreName: string;
    storeLocationId: number;
    visitors: number;
    exits: number;
  }[] = [];

  for (let dayOffset = 730; dayOffset >= 0; dayOffset--) {
    const day = new Date(today.getTime() - dayOffset * 86_400_000);
    const dow = day.getUTCDay();
    if (dow === 1) continue; // closed Mondays
    const weekendLift = dow === 0 || dow === 6 ? 1.9 : 1;

    for (const store of stores) {
      for (const hour of HOURS) {
        const intervalStart = new Date(day);
        intervalStart.setUTCHours(hour, 0, 0, 0);
        // Midday peak, tapering either side.
        const shape = 1 - Math.abs(hour - 13.5) / 9;
        const visitors = Math.max(0, Math.round(randInt(sRng, 6, 22) * shape * weekendLift));
        snapshots.push({
          intervalStart,
          sourceStoreName: store.name,
          storeLocationId: store.id,
          visitors,
          exits: Math.max(0, visitors - randInt(sRng, 0, 3)),
        });
      }
    }
    result.trafficDays += 1;
  }

  // Chunked so a single statement never carries the whole two years.
  for (let i = 0; i < snapshots.length; i += 1000) {
    await prisma.trafficSnapshot.createMany({ data: snapshots.slice(i, i + 1000) });
  }

  return result;
}
