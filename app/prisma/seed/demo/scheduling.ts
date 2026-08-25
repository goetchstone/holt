// /app/prisma/seed/demo/scheduling.ts
//
// The appointment-booking module: a public "book a design consultation" surface
// and the availability rules behind it.
//
// This is a different shape from the rest of the seed and it is worth saying so.
// Sales orders, purchase orders and service cases are all INTERNAL records staff
// create. These four models exist to answer a request from OUTSIDE: a visitor
// picks a service, the app works out when somebody is free, and a Booking lands
// in the calendar. Nothing else in the demo exercises that direction.
//
// Why each model has to be here for the module to demonstrate anything:
//
//   SERVICE -- the bookable thing, with a duration and a buffer. `isPublic`
//     splits the catalog: an in-home consultation is offered on the website, a
//     trade-only appointment is not. Seeding only public services would leave
//     that filter looking decorative.
//
//   AVAILABILITY WINDOW -- "Tuesdays 10:00-16:00". Without windows the booking
//     page has no slots to offer and renders an empty calendar that is
//     indistinguishable from a broken one. Windows are seeded per weekday and
//     some are bound to a specific designer, since "book with a named person"
//     and "book with anyone" are different flows.
//
//   CALENDAR BLOCK -- the exception that proves the rule works. A block over a
//     window is what makes a slot disappear; with no blocks anywhere, the
//     subtraction logic never runs and every slot always appears free.
//
//   BOOKING -- the result, seeded across all three states. PENDING is the one
//     that matters: a confirmation queue with nothing in it cannot show that it
//     is a queue, and CANCELLED rows are what stop a cancelled booking from
//     silently holding a slot forever.
//
// Times are stored as "HH:MM" strings local to the organization timezone, not
// instants -- a window is a weekly rule, not a moment.

import type { PrismaClient, BookingStatus } from "@prisma/client";
import type { Rng } from "./rng";
import { pick, randInt, subRng } from "./rng";
import type { StaffSetup } from "./staff";

const SEED_ACTOR = "seed:demo";

interface ServiceSpec {
  name: string;
  slug: string;
  durationMinutes: number;
  bufferMinutes: number;
  price: number | null;
  isPublic: boolean;
  description: string;
}

const SERVICES: ServiceSpec[] = [
  {
    name: "In-Home Design Consultation",
    slug: "in-home-design-consultation",
    durationMinutes: 90,
    bufferMinutes: 30,
    price: 150,
    isPublic: true,
    description: "A designer visits, measures the room and builds a plan with you.",
  },
  {
    name: "Showroom Appointment",
    slug: "showroom-appointment",
    durationMinutes: 60,
    bufferMinutes: 15,
    price: null,
    isPublic: true,
    description: "Walk the floor with a designer who knows what is in stock.",
  },
  {
    name: "Fabric & Finish Review",
    slug: "fabric-finish-review",
    durationMinutes: 45,
    bufferMinutes: 15,
    price: null,
    isPublic: true,
    description: "Narrow down grades, finishes and leathers against your samples.",
  },
  {
    // Not offered on the website: the trade desk books these directly.
    name: "Trade Account Review",
    slug: "trade-account-review",
    durationMinutes: 60,
    bufferMinutes: 0,
    price: null,
    isPublic: false,
    description: "Annual pricing and terms review for trade accounts.",
  },
];

const BOOKING_NAMES = [
  ["Alina Petrov", "alina.petrov@example.com"],
  ["Marcus Hale", "m.hale@example.com"],
  ["Priya Raman", "priya.raman@example.com"],
  ["Tobias Lund", "t.lund@example.com"],
  ["Grace Okafor", "g.okafor@example.com"],
  ["Devon Marsh", "devon.marsh@example.com"],
  ["Hana Sato", "hana.sato@example.com"],
  ["Rafael Ortiz", "r.ortiz@example.com"],
];

export interface SchedulingResult {
  servicesCreated: number;
  windowsCreated: number;
  blocksCreated: number;
  bookingsCreated: number;
  pendingBookings: number;
}

export async function seedScheduling(
  prisma: PrismaClient,
  rng: Rng,
  organizationId: number,
  staff: StaffSetup,
  today: Date,
): Promise<SchedulingResult> {
  const sRng = subRng(rng, "scheduling");
  const result: SchedulingResult = {
    servicesCreated: 0,
    windowsCreated: 0,
    blocksCreated: 0,
    bookingsCreated: 0,
    pendingBookings: 0,
  };

  const bookableStaff = staff.designers.length > 0 ? staff.designers : staff.all;

  // ---- the bookable catalog ---------------------------------------------
  const services = [];
  for (const [i, spec] of SERVICES.entries()) {
    services.push(
      await prisma.service.create({
        data: {
          organizationId,
          name: spec.name,
          slug: spec.slug,
          description: spec.description,
          durationMinutes: spec.durationMinutes,
          bufferMinutes: spec.bufferMinutes,
          price: spec.price,
          isPublic: spec.isPublic,
          isActive: true,
          sortOrder: i,
          createdBy: SEED_ACTOR,
        },
      }),
    );
    result.servicesCreated += 1;
  }

  // ---- when those things can be booked ----------------------------------
  // Tuesday-Saturday, which is a furniture showroom's week: closed Monday,
  // open the weekend. A Mon-Fri seed would quietly assume an office.
  const TRADING_DAYS = [2, 3, 4, 5, 6];
  for (const service of services) {
    for (const dayOfWeek of TRADING_DAYS) {
      await prisma.availabilityWindow.create({
        data: {
          organizationId,
          serviceId: service.id,
          dayOfWeek,
          startTime: dayOfWeek === 6 ? "10:00" : "09:30",
          endTime: dayOfWeek === 6 ? "16:00" : "17:30",
        },
      });
      result.windowsCreated += 1;
    }
  }

  // Two designers keep their own narrower hours. "Book with this person" and
  // "book with anyone" resolve slots differently, and only staff-bound windows
  // exercise the first.
  for (const member of bookableStaff.slice(0, 2)) {
    for (const dayOfWeek of [3, 4, 5]) {
      await prisma.availabilityWindow.create({
        data: {
          organizationId,
          staffMemberId: member.id,
          dayOfWeek,
          startTime: "11:00",
          endTime: "15:00",
        },
      });
      result.windowsCreated += 1;
    }
  }

  // ---- and when they cannot ---------------------------------------------
  // Blocks are the subtraction. With none, slot generation never has to remove
  // anything and a bug that ignores blocks entirely looks correct.
  const blockPlans = [
    { offset: 3, reason: "Market week - buying trip", allDay: true },
    { offset: 6, reason: "Team training", allDay: false },
    { offset: 11, reason: "Public holiday", allDay: true },
  ];
  for (const [i, plan] of blockPlans.entries()) {
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() + plan.offset);
    start.setUTCHours(plan.allDay ? 0 : 13, 0, 0, 0);
    const end = new Date(start);
    if (plan.allDay) end.setUTCDate(end.getUTCDate() + 1);
    else end.setUTCHours(16, 0, 0, 0);

    await prisma.calendarBlock.create({
      data: {
        organizationId,
        // The first block is store-wide; the others belong to one person.
        staffMemberId: i === 0 ? null : (bookableStaff[i % bookableStaff.length]?.id ?? null),
        startsAt: start,
        endsAt: end,
        reason: plan.reason,
      },
    });
    result.blocksCreated += 1;
  }

  // ---- what people actually booked --------------------------------------
  const publicServices = services.filter((s) => s.isPublic);
  for (const [i, [name, email]] of BOOKING_NAMES.entries()) {
    const service = pick(sRng, publicServices);
    // A spread of past and future: the past ones are history, the future ones
    // are what the calendar has to render.
    const dayOffset = i < 3 ? -randInt(sRng, 2, 20) : randInt(sRng, 1, 21);
    const startsAt = new Date(today);
    startsAt.setUTCDate(startsAt.getUTCDate() + dayOffset);
    startsAt.setUTCHours(randInt(sRng, 10, 15), 0, 0, 0);
    const endsAt = new Date(startsAt.getTime() + service.durationMinutes * 60_000);

    // Past bookings are settled; upcoming ones include a confirmation queue.
    let status: BookingStatus;
    if (dayOffset < 0) status = i === 0 ? "CANCELLED" : "CONFIRMED";
    else status = i % 3 === 0 ? "PENDING" : "CONFIRMED";

    await prisma.booking.create({
      data: {
        organizationId,
        customerName: name,
        customerEmail: email,
        customerPhone: `860-555-0${String(200 + i)}`,
        serviceId: service.id,
        serviceType: service.name,
        staffMemberId: status === "PENDING" ? null : (pick(sRng, bookableStaff)?.id ?? null),
        startsAt,
        endsAt,
        status,
        notes:
          status === "PENDING" ? "Requested through the website; awaiting confirmation." : null,
        createdBy: SEED_ACTOR,
      },
    });
    result.bookingsCreated += 1;
    if (status === "PENDING") result.pendingBookings += 1;
  }

  return result;
}
