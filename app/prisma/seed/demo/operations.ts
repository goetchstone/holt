// /app/prisma/seed/demo/operations.ts
//
// The last two dark nav sections: Helpdesk (`Ticket`) and Time
// (`TimeEntry`, `StaffShift`).
//
// Both are small domains with their own top-level nav entry, and both rendered
// an empty screen on a fresh clone. Seeded together because neither is big
// enough to justify its own module and both answer the same question — "does
// this part of the product do anything?"
//
// TICKETS are the no-login customer support surface. Every one carries a
// `publicToken`, because that token IS the authorization for
// `pages/api/tickets/public/[token].ts` — a customer follows a link and reads
// their own ticket with no account. Seeding tickets WITHOUT tokens would leave
// that whole path unexercised while looking populated.
//
// Internal vs customer-visible messages are both seeded, and the split matters:
// the public endpoint filters internal notes out, so a ticket with only public
// messages cannot demonstrate that it does.
//
// TIME entries are billable-consultancy shaped (`isBillable`, `billedAt`),
// which is the Akritos deployment's case rather than the furniture one. A mix
// of billed and unbilled is what makes the "what can I invoice" view non-empty.
//
// SHIFTS include exactly one open shift — `clockOut: null` means still on
// shift, and a board where nobody is clocked in cannot show its own primary
// state.

import type { PrismaClient, TicketPriority, TicketStatus } from "@prisma/client";
import type { Rng } from "./rng";
import { pick, randInt, subRng } from "./rng";
import type { SeededCustomer } from "./customers";
import type { StaffSetup } from "./staff";
import type { StoreSetup } from "./locations";

const SEED_ACTOR = "seed:demo";

const SUBJECTS = [
  "Delivery window needs to move",
  "Question about fabric care",
  "Invoice copy request",
  "Where is my order?",
  "Warranty registration help",
  "Swatch request for the sectional",
];

const TIME_TASKS = [
  "Client discovery call",
  "Floor plan revisions",
  "Vendor sourcing",
  "Install supervision",
  "Proposal preparation",
  "Site measurement",
];

export interface OperationsResult {
  ticketsCreated: number;
  openTickets: number;
  ticketMessages: number;
  timeEntries: number;
  unbilledMinutes: number;
  shiftsCreated: number;
  openShifts: number;
}

export async function seedOperations(
  prisma: PrismaClient,
  rng: Rng,
  organizationId: number,
  customers: SeededCustomer[],
  staff: StaffSetup,
  stores: StoreSetup[],
  ticketCount: number,
  timeEntryCount: number,
): Promise<OperationsResult> {
  const opsRng = subRng(rng, "operations");
  const result: OperationsResult = {
    ticketsCreated: 0,
    openTickets: 0,
    ticketMessages: 0,
    timeEntries: 0,
    unbilledMinutes: 0,
    shiftsCreated: 0,
    openShifts: 0,
  };

  const STATUSES: TicketStatus[] = [
    "OPEN",
    "IN_PROGRESS",
    "WAITING_ON_CUSTOMER",
    "RESOLVED",
    "CLOSED",
  ];
  const PRIORITIES: TicketPriority[] = ["LOW", "MEDIUM", "HIGH", "URGENT"];
  const agents = staff.all.filter((s) => s.role === "MANAGER" || s.role === "ADMIN");

  for (let i = 0; i < ticketCount; i++) {
    const status = pick(opsRng, STATUSES);
    const isClosed = status === "RESOLVED" || status === "CLOSED";
    const customer = pick(opsRng, customers);
    const daysAgo = isClosed ? randInt(opsRng, 10, 200) : randInt(opsRng, 1, 30);
    const opened = new Date(Date.now() - daysAgo * 86_400_000);
    const agent = agents.length > 0 ? pick(opsRng, agents) : null;

    const ticket = await prisma.ticket.create({
      data: {
        organizationId,
        ticketNumber: `TK-${String(2000 + i)}`,
        // The token IS the authorization for the no-login customer view.
        // Deterministic from the seeded RNG so a reseed is reproducible.
        publicToken: `seed-tok-${String(100000 + i)}-${randInt(opsRng, 100000, 999999)}`,
        customerId: customer.id,
        submitterName: `Customer ${customer.id}`,
        submitterEmail: `customer${customer.id}@example.com`,
        subject: pick(opsRng, SUBJECTS),
        status,
        priority: pick(opsRng, PRIORITIES),
        assignedToId: agent?.id ?? null,
        resolvedAt: isClosed ? new Date(opened.getTime() + 3 * 86_400_000) : null,
        created: opened,
      },
    });
    result.ticketsCreated++;
    if (!isClosed) result.openTickets++;

    // One customer-visible message and one internal note. The public endpoint
    // filters internal notes out; a ticket with only public messages cannot
    // demonstrate that it does.
    await prisma.ticketMessage.create({
      data: {
        ticketId: ticket.id,
        authorName: `Customer ${customer.id}`,
        body: "Following up on this — any update?",
        isInternal: false,
        created: new Date(opened.getTime() + 3_600_000),
      },
    });
    await prisma.ticketMessage.create({
      data: {
        ticketId: ticket.id,
        authorStaffId: agent?.id ?? null,
        authorName: agent?.displayName ?? null,
        body: "Checked with the warehouse; confirming the delivery slot.",
        isInternal: true,
        created: new Date(opened.getTime() + 7_200_000),
      },
    });
    result.ticketMessages += 2;
  }

  // Time entries: billable-consultancy shaped. A mix of billed and unbilled is
  // what makes the "what can I invoice" view non-empty.
  const timeStaff = staff.designers.length > 0 ? staff.designers : staff.all;
  for (let i = 0; i < timeEntryCount; i++) {
    const member = pick(opsRng, timeStaff);
    const daysAgo = randInt(opsRng, 1, 120);
    const date = new Date(Date.now() - daysAgo * 86_400_000);
    const minutes = randInt(opsRng, 2, 16) * 15;
    const isBillable = randInt(opsRng, 1, 100) <= 80;
    const billed = isBillable && randInt(opsRng, 1, 100) <= 60;

    await prisma.timeEntry.create({
      data: {
        organizationId,
        staffMemberId: member.id,
        customerId: pick(opsRng, customers).id,
        description: pick(opsRng, TIME_TASKS),
        minutes,
        date,
        isBillable,
        billedAt: billed ? new Date(date.getTime() + 20 * 86_400_000) : null,
        createdBy: SEED_ACTOR,
      },
    });
    result.timeEntries++;
    if (isBillable && !billed) result.unbilledMinutes += minutes;
  }

  // Shifts, including exactly one still open. A board where nobody is clocked
  // in cannot show its own primary state.
  const shiftStaff = staff.registerStaff.length > 0 ? staff.registerStaff : staff.all;
  for (let i = 0; i < shiftStaff.length * 3; i++) {
    const member = shiftStaff[i % shiftStaff.length];
    const store = pick(opsRng, stores);
    const daysAgo = randInt(opsRng, 1, 30);
    const clockIn = new Date(Date.now() - daysAgo * 86_400_000);
    clockIn.setHours(9, 0, 0, 0);
    const stillOn = i === 0;

    await prisma.staffShift.create({
      data: {
        staffMemberId: member.id,
        storeLocation: store.name,
        storeLocationId: store.id,
        clockIn,
        clockOut: stillOn ? null : new Date(clockIn.getTime() + randInt(opsRng, 6, 9) * 3_600_000),
      },
    });
    result.shiftsCreated++;
    if (stillOn) result.openShifts++;
  }

  return result;
}
