// /app/__tests__/integration/clientPortal.integration.test.ts
//
// Real-DB proof of the client-portal data assembly: bookings matched by the
// customer's email (case-insensitive, cancelled excluded), authored invoices
// with open balances (drafts and other customers' invoices excluded), and
// tickets linked by customerId OR submitter email — and, critically, that
// NOTHING from another customer leaks into the hub.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { getClientPortalData } from "@/lib/clientPortal";

describe("getClientPortalData against a real DB", () => {
  beforeEach(async () => {
    await resetTestDb();
    await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } }); // id 1
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("assembles the customer's own appointments, invoices, and tickets — and only theirs", async () => {
    const me = await prisma.customer.create({
      data: { firstName: "Dana", lastName: "Client", email: "Dana@Client.test" },
    });
    const other = await prisma.customer.create({
      data: { firstName: "Other", email: "other@client.test" },
    });

    await prisma.booking.createMany({
      data: [
        {
          organizationId: 1,
          customerName: "Dana Client",
          customerEmail: "dana@client.test", // case differs from the Customer row
          startsAt: new Date(2027, 0, 10, 10),
          endsAt: new Date(2027, 0, 10, 11),
          status: "CONFIRMED",
        },
        {
          organizationId: 1,
          customerName: "Dana Client",
          customerEmail: "dana@client.test",
          startsAt: new Date(2027, 0, 12, 10),
          endsAt: new Date(2027, 0, 12, 11),
          status: "CANCELLED", // excluded
        },
        {
          organizationId: 1,
          customerName: "Other",
          customerEmail: "other@client.test", // not mine
          startsAt: new Date(2027, 0, 11, 10),
          endsAt: new Date(2027, 0, 11, 11),
          status: "CONFIRMED",
        },
      ],
    });

    await prisma.invoice.create({
      data: {
        invoiceNo: "INV-1",
        invoiceDate: new Date(),
        taxAmount: 0,
        organizationId: 1,
        customerId: me.id,
        total: 500,
        status: "ISSUED",
        applications: undefined,
      },
    });
    await prisma.invoice.create({
      data: {
        invoiceNo: "INV-DRAFT",
        invoiceDate: new Date(),
        taxAmount: 0,
        organizationId: 1,
        customerId: me.id,
        total: 100,
        status: "DRAFT", // hidden from the client
      },
    });
    await prisma.invoice.create({
      data: {
        invoiceNo: "INV-OTHER",
        invoiceDate: new Date(),
        taxAmount: 0,
        organizationId: 1,
        customerId: other.id,
        total: 900,
        status: "ISSUED",
      },
    });

    await prisma.ticket.createMany({
      data: [
        {
          organizationId: 1,
          ticketNumber: "T-1",
          publicToken: "tok-mine-by-id",
          customerId: me.id,
          subject: "Linked by customer id",
        },
        {
          organizationId: 1,
          ticketNumber: "T-2",
          publicToken: "tok-mine-by-email",
          submitterEmail: "DANA@client.test",
          subject: "Linked by email",
        },
        {
          organizationId: 1,
          ticketNumber: "T-3",
          publicToken: "tok-other",
          customerId: other.id,
          subject: "Someone else's",
        },
      ],
    });

    const data = await getClientPortalData(me.id);
    expect(data).not.toBeNull();
    expect(data!.customerName).toBe("Dana Client");

    expect(data!.appointments).toHaveLength(1);
    expect(data!.appointments[0].status).toBe("CONFIRMED");

    expect(data!.invoices).toHaveLength(1);
    expect(data!.invoices[0]).toMatchObject({
      invoiceNo: "INV-1",
      total: 500,
      openBalance: 500,
    });

    const ticketNos = data!.tickets.map((t) => t.ticketNumber).sort();
    expect(ticketNos).toEqual(["T-1", "T-2"]);
    expect(data!.tickets.every((t) => t.statusToken.startsWith("tok-mine"))).toBe(true);
  });

  it("returns null for an unknown customer", async () => {
    expect(await getClientPortalData(99999)).toBeNull();
  });
});
