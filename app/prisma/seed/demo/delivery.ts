// /app/prisma/seed/demo/delivery.ts
//
// Fulfilment: how a sold thing gets from the warehouse into a customer's house.
//
// This is the tranche a demo notices first, because Delivery is a top-level nav
// section and every screen under it rendered empty on a fresh clone. Worse than
// empty: the dispatch board, the run sheet and the pick list all LOOK like
// features until you click them, so an empty fulfilment module reads as a
// missing one.
//
// What is seeded and why each piece has to exist:
//
//   ZONES + ZIPS  -- delivery pricing is per-zone, and a zone with no zip codes
//     can never be resolved from a customer address. Seeding zones alone would
//     leave the lookup that matters untested and the fee always $0. One zone is
//     deliberately third-party (`isThirdParty`, `carrierName`): a store that
//     ships some deliveries via a carrier is the normal case, and code paths
//     branching on it are otherwise unexercised.
//
//   TAX DISTRICT ZIPS -- the same address-to-geography lookup on the tax side.
//     TaxRule already models banded rates; without zips nothing resolves a
//     district from an address and every order falls back to the store default.
//
//   VEHICLES + INSTALLERS -- a run needs a truck and a stop may need a fitter.
//     Installers include an in-house one (`company: null`) and a third-party
//     contractor, because that null IS the distinction the UI draws.
//
//   PRINTERS -- warehouse tag printers. Small, but Admin -> Setup -> Printers
//     is a real screen and an empty one suggests tag printing does not exist.
//
//   APPOINTMENTS -> RUNS -> STOPS -- the actual chain. A DeliveryStop is unique
//     per ServiceAppointment, so appointments must come first. Runs are seeded
//     across three states (COMPLETED yesterday, IN_PROGRESS today, PLANNING
//     tomorrow) because a board that can only show one state cannot demonstrate
//     that it is a board.
//
//   PICK LISTS -- what the warehouse actually walks with, tied to the run. Items
//     carry from/to stock locations, since a pick list that does not say where
//     to pick from is a piece of paper.
//
// Deliberately NOT here: the money. Delivery fees, order status transitions and
// inventory consumption are owned by salesOrders.ts and inventory.ts; this file
// only ever adds fulfilment records over the orders they already made.

import type { PrismaClient, DeliveryRunStatus, ServiceAppointmentStatus } from "@prisma/client";
import type { Rng } from "./rng";
import { pick, randInt, subRng } from "./rng";
import type { StaffSetup } from "./staff";
import type { StoreSetup } from "./locations";

const SEED_ACTOR = "seed:demo";

interface ZoneSpec {
  name: string;
  baseFee: number;
  perPieceFee: number | null;
  zips: string[];
  isThirdParty?: boolean;
  carrierName?: string;
}

// Local, then progressively further out, then a carrier for anything beyond the
// van's range. That shape -- not the specific towns -- is what every furniture
// retailer's zone table looks like.
const ZONES: ZoneSpec[] = [
  { name: "Local", baseFee: 79, perPieceFee: 15, zips: ["06776", "06777", "06783", "06793"] },
  { name: "Regional", baseFee: 149, perPieceFee: 25, zips: ["06001", "06070", "06107", "06371"] },
  { name: "Extended", baseFee: 249, perPieceFee: 40, zips: ["02806", "02840", "10514", "10573"] },
  {
    name: "Long Haul (carrier)",
    baseFee: 425,
    perPieceFee: null,
    zips: ["19103", "20007", "27514"],
    isThirdParty: true,
    carrierName: "Sunbelt Freight",
  },
];

const INSTALLERS = [
  { name: "In-House Install Crew", company: null, phone: "860-555-0142" },
  { name: "Whitfield Assembly", company: "Whitfield Assembly LLC", phone: "860-555-0188" },
  { name: "Ridgeline Fitters", company: "Ridgeline Fitters Inc", phone: "203-555-0119" },
];

export interface DeliveryResult {
  zonesCreated: number;
  zipsCreated: number;
  taxZipsCreated: number;
  vehiclesCreated: number;
  installersCreated: number;
  printersCreated: number;
  appointmentsCreated: number;
  runsCreated: number;
  stopsCreated: number;
  pickListsCreated: number;
  pickListItemsCreated: number;
}

export async function seedDelivery(
  prisma: PrismaClient,
  rng: Rng,
  staff: StaffSetup,
  stores: StoreSetup[],
  taxDistrictId: number,
  today: Date,
): Promise<DeliveryResult> {
  const dRng = subRng(rng, "delivery");
  const result: DeliveryResult = {
    zonesCreated: 0,
    zipsCreated: 0,
    taxZipsCreated: 0,
    vehiclesCreated: 0,
    installersCreated: 0,
    printersCreated: 0,
    appointmentsCreated: 0,
    runsCreated: 0,
    stopsCreated: 0,
    pickListsCreated: 0,
    pickListItemsCreated: 0,
  };

  // ---- zones and their zip coverage -------------------------------------
  const zoneIds: number[] = [];
  for (const [i, spec] of ZONES.entries()) {
    const zone = await prisma.deliveryZone.create({
      data: {
        name: spec.name,
        baseFee: spec.baseFee,
        perPieceFee: spec.perPieceFee,
        isThirdParty: spec.isThirdParty ?? false,
        carrierName: spec.carrierName ?? null,
        sortOrder: i,
        createdBy: SEED_ACTOR,
      },
    });
    zoneIds.push(zone.id);
    result.zonesCreated += 1;

    for (const zip of spec.zips) {
      await prisma.deliveryZoneZip.create({
        data: { deliveryZoneId: zone.id, zipCode: zip },
      });
      result.zipsCreated += 1;
    }
  }

  // ---- the same geography, on the tax side ------------------------------
  // Every delivery zip is also a tax zip: an address the store delivers to is
  // an address it has to charge tax for.
  for (const spec of ZONES) {
    for (const zip of spec.zips) {
      await prisma.taxDistrictZipCode.create({
        data: { districtId: taxDistrictId, zipCode: zip },
      });
      result.taxZipsCreated += 1;
    }
  }

  // ---- trucks -----------------------------------------------------------
  const vehicles = [];
  for (const name of ["Box Truck 1", "Box Truck 2", "Sprinter Van"]) {
    vehicles.push(
      await prisma.vehicle.create({
        data: { name, type: name.includes("Van") ? "VAN" : "BOX_TRUCK", createdBy: SEED_ACTOR },
      }),
    );
    result.vehiclesCreated += 1;
  }

  // ---- installers: one in-house, two contracted -------------------------
  for (const inst of INSTALLERS) {
    await prisma.installer.create({
      data: {
        name: inst.name,
        company: inst.company,
        phone: inst.phone,
        isActive: true,
        createdBy: SEED_ACTOR,
      },
    });
    result.installersCreated += 1;
  }

  // ---- tag printers -----------------------------------------------------
  for (const store of stores) {
    await prisma.printer.create({
      data: {
        name: `${store.name} Warehouse`,
        ipAddress: `10.20.${store.id}.50`,
        tagType: "PRODUCT_TAG",
        location: "Receiving bay",
        store: store.name,
        supportedSizes: ["4x6", "2x4"],
        currentSize: "4x6",
        createdBy: SEED_ACTOR,
      },
    });
    result.printersCreated += 1;
  }

  // ---- appointments, runs, stops, pick lists ----------------------------
  // Only orders that actually have line items can be delivered; an appointment
  // against an empty order would make a run sheet with nothing on it.
  const deliverable = await prisma.salesOrder.findMany({
    where: { status: { in: ["ORDER", "FULFILLED"] }, lineItems: { some: {} } },
    select: {
      id: true,
      customerId: true,
      storeLocation: true,
      lineItems: {
        where: { lineItemStatus: { not: "CANCELLED" }, productId: { not: null } },
        select: { id: true, productId: true, orderedQuantity: true },
        take: 4,
      },
    },
    orderBy: { orderDate: "desc" },
    take: 24,
  });

  if (deliverable.length === 0) return result;

  const drivers = staff.warehouseStaff.length > 0 ? staff.warehouseStaff : staff.all;

  // Three runs, three states. A dispatch board that can only render one state
  // demonstrates nothing about being a board.
  const runPlans: { status: DeliveryRunStatus; dayOffset: number; orders: typeof deliverable }[] = [
    { status: "COMPLETED", dayOffset: -1, orders: deliverable.slice(0, 4) },
    { status: "IN_PROGRESS", dayOffset: 0, orders: deliverable.slice(4, 8) },
    { status: "PLANNING", dayOffset: 1, orders: deliverable.slice(8, 12) },
  ];

  for (const [runIndex, plan] of runPlans.entries()) {
    if (plan.orders.length === 0) continue;

    const runDate = new Date(today);
    runDate.setUTCDate(runDate.getUTCDate() + plan.dayOffset);
    const vehicle = vehicles[runIndex % vehicles.length];
    const driver = drivers.length > 0 ? pick(dRng, drivers) : null;

    const run = await prisma.deliveryRun.create({
      data: {
        runNumber: `RUN-${runDate.toISOString().slice(0, 10).replace(/-/g, "")}-${runIndex + 1}`,
        runDate,
        vehicleId: vehicle.id,
        driverId: driver?.id ?? null,
        status: plan.status,
        departedAt: plan.status === "PLANNING" ? null : runDate,
        completedAt: plan.status === "COMPLETED" ? runDate : null,
        createdBy: SEED_ACTOR,
      },
    });
    result.runsCreated += 1;

    // One pick list per run: what the warehouse walks the floor with.
    const pickList = await prisma.pickList.create({
      data: {
        pickListNumber: `PL-${run.runNumber.slice(4)}`,
        deliveryRunId: run.id,
        status:
          plan.status === "COMPLETED"
            ? "COMPLETED"
            : plan.status === "IN_PROGRESS"
              ? "IN_PROGRESS"
              : "CREATED",
        assignedToId: drivers.length > 0 ? pick(dRng, drivers).id : null,
        createdBy: SEED_ACTOR,
      },
    });
    result.pickListsCreated += 1;

    for (const [stopIndex, order] of plan.orders.entries()) {
      const store = stores.find((s) => s.name === order.storeLocation) ?? stores[0];

      const appointmentStatus: ServiceAppointmentStatus =
        plan.status === "COMPLETED"
          ? "COMPLETED"
          : plan.status === "IN_PROGRESS"
            ? "IN_PROGRESS"
            : "SCHEDULED";

      const appointment = await prisma.serviceAppointment.create({
        data: {
          appointmentNumber: `APPT-${run.runNumber.slice(4)}-${stopIndex + 1}`,
          type: "DELIVERY",
          status: appointmentStatus,
          salesOrderId: order.id,
          customerId: order.customerId,
          storeLocationId: store?.id ?? null,
          deliveryZoneId: zoneIds[randInt(dRng, 0, zoneIds.length - 1)],
          scheduledDate: runDate,
          scheduledTime: `${String(9 + stopIndex * 2).padStart(2, "0")}:00`,
          estimatedDuration: 60,
          completedAt: plan.status === "COMPLETED" ? runDate : null,
          createdBy: SEED_ACTOR,
        },
      });
      result.appointmentsCreated += 1;

      await prisma.deliveryStop.create({
        data: {
          deliveryRunId: run.id,
          serviceAppointmentId: appointment.id,
          stopOrder: stopIndex + 1,
          status:
            plan.status === "COMPLETED"
              ? "COMPLETED"
              : plan.status === "IN_PROGRESS" && stopIndex === 0
                ? "EN_ROUTE"
                : "PENDING",
          estimatedArrival: runDate,
          completedAt: plan.status === "COMPLETED" ? runDate : null,
          recipientName: plan.status === "COMPLETED" ? "Signed on delivery" : null,
        },
      });
      result.stopsCreated += 1;

      for (const line of order.lineItems) {
        if (line.productId == null) continue;
        await prisma.pickListItem.create({
          data: {
            pickListId: pickList.id,
            orderLineItemId: line.id,
            productId: line.productId,
            quantity: Math.max(1, Math.round(Number(line.orderedQuantity ?? 1))),
            fromStoreLocationId: store?.id ?? null,
            fromStockLocationId: store?.backStockLocationId ?? null,
            picked: plan.status === "COMPLETED",
            pickedAt: plan.status === "COMPLETED" ? runDate : null,
          },
        });
        result.pickListItemsCreated += 1;
      }
    }
  }

  return result;
}
