// app/scripts/migrate-simplerms.mjs
//
// One-time data migration: a simplerms database -> this Holt deployment.
// Built for the Akritos cutover (docs/DEPLOYMENTS.md "Rebasing simplerms
// onto Holt"); dry-run it against a copy of the production dump BEFORE the
// real run. Idempotent: every entity matches on a natural key (invoice
// number, ticket number, service slug, customer email) and updates instead
// of duplicating, so a re-run after a partial failure converges.
//
// Usage:
//   SOURCE_DATABASE_URL=postgres://.../simplerms \
//   DATABASE_URL=postgres://.../holt \
//   node scripts/migrate-simplerms.mjs [--dry-run]
//
// Reads the SOURCE with raw SQL (pg) — its schema is simplerms's, not ours.
// Writes the TARGET through Holt's Prisma client so defaults/validation
// apply. Never lossy: fields with no Holt home (Client.company, invoice
// publicToken, ...) land in migration-exceptions.json next to this script.
//
// Entity map (simplerms -> Holt):
//   Client                -> Customer (name split first/last; email natural key)
//   Invoice + InvoiceLine -> Invoice (authored path: organizationId=1,
//                            freeform InvoiceLineItem) + status map
//                            DRAFT->DRAFT, VOID->VOID, PAID->PAID,
//                            SENT/VIEWED/PARTIAL/OVERDUE->ISSUED
//   Payment               -> Payment (COMPLETED, invoiceId-bound) +
//                            PaymentApplication
//   ...plus per-invoice SALE and per-payment PAYMENT customer-ledger rows so
//   the AR subledger + drift check tie out from day one.
//   Ticket + TicketMessage-> Ticket + TicketMessage (tokens preserved;
//                            WAITING_ON_CLIENT -> WAITING_ON_CUSTOMER)
//   Service               -> Service (slug natural key)
//   Appointment           -> Booking (PENDING/CONFIRMED/CANCELLED;
//                            NO_SHOW/COMPLETED -> CONFIRMED past events)
//   TimeEntry             -> TimeEntry (staff resolved by user email)
//   Lead                  -> Lead (source WEBSITE, sourceDetail preserved)
//   CmsPage/CmsPost       -> SKIPPED (the akritos seed is canonical for CMS)
//   File                  -> SKIPPED v1 (storage paths differ; listed in
//                            exceptions so nothing silently disappears)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const DRY_RUN = process.argv.includes("--dry-run");
const ORG_ID = 1;

const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.DATABASE_URL;
if (!sourceUrl || !targetUrl) {
  console.error("SOURCE_DATABASE_URL and DATABASE_URL are both required");
  process.exit(1);
}

const source = new pg.Client({ connectionString: sourceUrl });
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: targetUrl }) });

const counts = {};
const exceptions = [];
function bump(entity, key = "migrated") {
  counts[entity] = counts[entity] ?? {};
  counts[entity][key] = (counts[entity][key] ?? 0) + 1;
}
function except(entity, ref, field, value) {
  exceptions.push({ entity, ref, field, value });
}

function splitName(name) {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? null, lastName: parts.slice(1).join(" ") || null };
}

const INVOICE_STATUS = {
  DRAFT: "DRAFT",
  SENT: "ISSUED",
  VIEWED: "ISSUED",
  PARTIAL: "ISSUED",
  OVERDUE: "ISSUED",
  PAID: "PAID",
  VOID: "VOID",
};
const TICKET_STATUS = {
  OPEN: "OPEN",
  IN_PROGRESS: "IN_PROGRESS",
  WAITING_ON_CLIENT: "WAITING_ON_CUSTOMER",
  RESOLVED: "RESOLVED",
  CLOSED: "CLOSED",
};
const APPT_STATUS = {
  PENDING: "PENDING",
  CONFIRMED: "CONFIRMED",
  CANCELLED: "CANCELLED",
  NO_SHOW: "CONFIRMED",
  COMPLETED: "CONFIRMED",
};
const PAYMENT_METHOD = {
  STRIPE: "CARD",
  CASH: "CASH",
  CHECK: "CHECK",
  BANK_TRANSFER: "WIRE",
  OTHER: "OTHER",
};

// old cuid -> new Holt int id, per entity
const customerIds = new Map();
const serviceIds = new Map();
const staffByEmail = new Map();

async function migrateCustomers() {
  const { rows } = await source.query('SELECT * FROM "Client" ORDER BY "createdAt"');
  for (const c of rows) {
    const { firstName, lastName } = splitName(c.name);
    if (c.company) except("Client", c.name, "company", c.company);
    if (c.address) except("Client", c.name, "address(Json)", JSON.stringify(c.address));
    const data = {
      firstName,
      lastName,
      email: c.email?.trim().toLowerCase() || null,
      phone: c.phone || null,
    };
    if (DRY_RUN) {
      bump("Customer", "would-migrate");
      customerIds.set(c.id, -1);
      continue;
    }
    const existing = data.email
      ? await prisma.customer.findFirst({ where: { email: data.email }, select: { id: true } })
      : null;
    const row = existing
      ? await prisma.customer.update({ where: { id: existing.id }, data })
      : await prisma.customer.create({ data });
    customerIds.set(c.id, row.id);
    bump("Customer", existing ? "updated" : "created");
  }
  // Notes + activity become a single exceptions listing per client for now —
  // Holt's interaction model is staff-attributed and these have no author.
  const notes = await source.query('SELECT n.*, c.name FROM "Note" n JOIN "Client" c ON c.id = n."clientId"');
  for (const n of notes.rows) except("Note", n.name, "content", n.content?.slice(0, 500));
}

async function migrateServices() {
  const { rows } = await source.query('SELECT * FROM "Service"');
  for (const s of rows) {
    const data = {
      organizationId: ORG_ID,
      name: s.name,
      slug: s.slug,
      description: s.description ?? null,
      durationMinutes: s.duration,
      bufferMinutes: s.bufferAfter,
      price: s.price,
      isPublic: s.isPublic,
      isActive: s.isActive,
    };
    if (DRY_RUN) {
      bump("Service", "would-migrate");
      serviceIds.set(s.id, -1);
      continue;
    }
    const existing = await prisma.service.findFirst({
      where: { organizationId: ORG_ID, slug: s.slug },
      select: { id: true },
    });
    const row = existing
      ? await prisma.service.update({ where: { id: existing.id }, data })
      : await prisma.service.create({ data });
    serviceIds.set(s.id, row.id);
    bump("Service", existing ? "updated" : "created");
  }
}

async function migrateInvoices() {
  const { rows } = await source.query('SELECT * FROM "Invoice" ORDER BY "issueDate"');
  for (const inv of rows) {
    const customerId = customerIds.get(inv.clientId) ?? null;
    const status = INVOICE_STATUS[inv.status] ?? "ISSUED";
    if (inv.publicToken) except("Invoice", inv.invoiceNumber, "publicToken", inv.publicToken);
    const lines = await source.query(
      'SELECT * FROM "InvoiceLine" WHERE "invoiceId" = $1 ORDER BY "sortOrder"',
      [inv.id],
    );
    if (DRY_RUN) {
      bump("Invoice", "would-migrate");
      for (const _ of lines.rows) bump("InvoiceLineItem", "would-migrate");
      continue;
    }
    const existing = await prisma.invoice.findUnique({
      where: { invoiceNo: inv.invoiceNumber },
      select: { id: true },
    });
    const data = {
      invoiceNo: inv.invoiceNumber,
      invoiceDate: inv.issueDate,
      issuedAt: inv.sentAt ?? (status !== "DRAFT" ? inv.issueDate : null),
      dueDate: inv.dueDate,
      taxAmount: inv.taxTotal,
      total: inv.total,
      status,
      notes: inv.notes ?? null,
      organizationId: ORG_ID,
      customerId,
      createdBy: "migrate-simplerms",
    };
    let invoiceId;
    if (existing) {
      await prisma.invoiceLineItem.deleteMany({ where: { invoiceId: existing.id } });
      await prisma.invoice.update({ where: { id: existing.id }, data });
      invoiceId = existing.id;
      bump("Invoice", "updated");
    } else {
      const row = await prisma.invoice.create({ data, select: { id: true } });
      invoiceId = row.id;
      bump("Invoice", "created");
    }
    if (lines.rows.length > 0) {
      await prisma.invoiceLineItem.createMany({
        data: lines.rows.map((l, i) => ({
          invoiceId,
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          amount: l.lineTotal,
          sortOrder: i,
        })),
      });
      for (const _ of lines.rows) bump("InvoiceLineItem", "created");
    }

    // Payments + open-item applications, bound via Payment.invoiceId.
    const pays = await source.query('SELECT * FROM "Payment" WHERE "invoiceId" = $1', [inv.id]);
    for (const p of pays.rows) {
      const ref = `${inv.invoiceNumber}:${p.id}`;
      const already = await prisma.payment.findFirst({
        where: { invoiceId, processorTxnId: ref },
        select: { id: true },
      });
      if (already) {
        bump("Payment", "skipped-existing");
        continue;
      }
      const payment = await prisma.payment.create({
        data: {
          paymentDate: p.paidAt,
          paymentType: PAYMENT_METHOD[p.method] === "CARD" ? "Card" : (PAYMENT_METHOD[p.method] ?? "Other"),
          paymentAmount: p.amount,
          status: "COMPLETED",
          method: PAYMENT_METHOD[p.method] ?? "OTHER",
          customerId,
          invoiceId,
          // Source-payment fingerprint = idempotency key for re-runs.
          processorTxnId: ref,
          processorType: p.method === "STRIPE" ? "STRIPE" : null,
          checkNumber: p.method === "CHECK" ? (p.reference ?? null) : null,
          createdBy: "migrate-simplerms",
        },
        select: { id: true },
      });
      await prisma.paymentApplication.create({
        data: {
          organizationId: ORG_ID,
          paymentId: payment.id,
          invoiceId,
          amountApplied: p.amount,
          createdBy: "migrate-simplerms",
        },
      });
      bump("Payment", "created");
    }
  }
}

// Subledger backfill: one SALE per ISSUED/PAID invoice, one PAYMENT per
// payment, then openArBalance = the running sum — same events the live flow
// writes, so the AR drift check ties out immediately after migration.
async function backfillLedger() {
  if (DRY_RUN) return;
  const invoices = await prisma.invoice.findMany({
    where: { organizationId: ORG_ID, createdBy: "migrate-simplerms" },
    select: {
      id: true,
      invoiceNo: true,
      customerId: true,
      total: true,
      status: true,
      issuedAt: true,
      payments: { select: { id: true, paymentAmount: true, paymentDate: true } },
    },
  });
  const balances = new Map();
  for (const inv of invoices) {
    if (!inv.customerId || inv.total === null) continue;
    const exists = await prisma.customerLedgerEntry.findFirst({
      where: { invoiceId: inv.id, type: "SALE" },
      select: { id: true },
    });
    const total = Number(inv.total);
    if (!exists && (inv.status === "ISSUED" || inv.status === "PAID")) {
      await prisma.customerLedgerEntry.create({
        data: {
          customerId: inv.customerId,
          type: "SALE",
          amount: total,
          invoiceId: inv.id,
          reference: inv.invoiceNo,
          createdBy: "migrate-simplerms",
        },
      });
      bump("LedgerEntry", "sale");
    }
    if (inv.status === "ISSUED" || inv.status === "PAID") {
      balances.set(inv.customerId, (balances.get(inv.customerId) ?? 0) + total);
    }
    for (const p of inv.payments) {
      const pExists = await prisma.customerLedgerEntry.findFirst({
        where: { paymentId: p.id, type: "PAYMENT" },
        select: { id: true },
      });
      if (!pExists) {
        await prisma.customerLedgerEntry.create({
          data: {
            customerId: inv.customerId,
            type: "PAYMENT",
            amount: -Number(p.paymentAmount),
            paymentId: p.id,
            invoiceId: inv.id,
            reference: inv.invoiceNo,
            createdBy: "migrate-simplerms",
          },
        });
        bump("LedgerEntry", "payment");
      }
      balances.set(inv.customerId, (balances.get(inv.customerId) ?? 0) - Number(p.paymentAmount));
    }
  }
  for (const [customerId, balance] of balances) {
    await prisma.customer.update({
      where: { id: customerId },
      data: { openArBalance: Math.round(balance * 100) / 100 },
    });
  }
}

async function migrateTickets() {
  const { rows } = await source.query('SELECT * FROM "Ticket" ORDER BY "createdAt"');
  for (const t of rows) {
    if (DRY_RUN) {
      bump("Ticket", "would-migrate");
      continue;
    }
    const data = {
      organizationId: ORG_ID,
      ticketNumber: t.ticketNumber,
      publicToken: t.publicToken,
      customerId: customerIds.get(t.clientId) ?? null,
      submitterName: t.submitterName,
      submitterEmail: t.submitterEmail,
      subject: t.subject,
      status: TICKET_STATUS[t.status] ?? "OPEN",
      priority: t.priority,
      resolvedAt: t.resolvedAt,
    };
    const existing = await prisma.ticket.findUnique({
      where: { ticketNumber: t.ticketNumber },
      select: { id: true },
    });
    const row = existing
      ? await prisma.ticket.update({ where: { id: existing.id }, data, select: { id: true } })
      : await prisma.ticket.create({ data, select: { id: true } });
    bump("Ticket", existing ? "updated" : "created");

    const msgs = await source.query(
      'SELECT * FROM "TicketMessage" WHERE "ticketId" = $1 ORDER BY "createdAt"',
      [t.id],
    );
    await prisma.ticketMessage.deleteMany({ where: { ticketId: row.id } });
    for (const m of msgs.rows) {
      await prisma.ticketMessage.create({
        data: {
          ticketId: row.id,
          authorName: m.senderName ?? null,
          body: m.body,
          isInternal: m.isInternal,
          created: m.createdAt,
        },
      });
      bump("TicketMessage", "created");
    }
  }
}

async function migrateAppointments() {
  const { rows } = await source.query('SELECT * FROM "Appointment" ORDER BY "startsAt"');
  for (const a of rows) {
    if (DRY_RUN) {
      bump("Booking", "would-migrate");
      continue;
    }
    const serviceId = serviceIds.get(a.serviceId) ?? null;
    const existing = await prisma.booking.findFirst({
      where: { organizationId: ORG_ID, customerEmail: a.bookerEmail, startsAt: a.startsAt },
      select: { id: true },
    });
    const data = {
      organizationId: ORG_ID,
      customerName: a.bookerName,
      customerEmail: a.bookerEmail,
      customerPhone: a.bookerPhone,
      serviceId,
      startsAt: a.startsAt,
      endsAt: a.endsAt,
      notes: a.notes,
      status: APPT_STATUS[a.status] ?? "PENDING",
    };
    if (existing) {
      await prisma.booking.update({ where: { id: existing.id }, data });
      bump("Booking", "updated");
    } else {
      await prisma.booking.create({ data });
      bump("Booking", "created");
    }
  }
}

async function migrateTimeEntries() {
  const staff = await prisma.staffMember.findMany({ select: { id: true, email: true } });
  for (const s of staff) if (s.email) staffByEmail.set(s.email.toLowerCase(), s.id);
  const { rows } = await source.query(
    'SELECT te.*, u.email AS user_email FROM "TimeEntry" te JOIN "User" u ON u.id = te."userId"',
  );
  for (const te of rows) {
    const staffMemberId = staffByEmail.get((te.user_email ?? "").toLowerCase());
    if (!staffMemberId) {
      except("TimeEntry", te.description?.slice(0, 60), "user (no Holt staff match)", te.user_email);
      bump("TimeEntry", "skipped-no-staff");
      continue;
    }
    if (DRY_RUN) {
      bump("TimeEntry", "would-migrate");
      continue;
    }
    const existing = await prisma.timeEntry.findFirst({
      where: { organizationId: ORG_ID, staffMemberId, date: te.date, description: te.description },
      select: { id: true },
    });
    if (existing) {
      bump("TimeEntry", "skipped-existing");
      continue;
    }
    await prisma.timeEntry.create({
      data: {
        organizationId: ORG_ID,
        staffMemberId,
        customerId: customerIds.get(te.clientId) ?? null,
        description: te.description,
        minutes: te.minutes,
        date: te.date,
        isBillable: te.isBillable,
        createdBy: "migrate-simplerms",
      },
    });
    bump("TimeEntry", "created");
  }
}

async function migrateLeads() {
  const { rows } = await source.query('SELECT * FROM "Lead"');
  for (const l of rows) {
    if (DRY_RUN) {
      bump("Lead", "would-migrate");
      continue;
    }
    const email = l.email?.trim().toLowerCase() || null;
    const existing = email
      ? await prisma.lead.findFirst({
          where: { email: { equals: email, mode: "insensitive" } },
          select: { id: true },
        })
      : null;
    if (existing) {
      bump("Lead", "skipped-existing");
      continue;
    }
    const { firstName, lastName } = splitName(l.name ?? "");
    await prisma.lead.create({
      data: {
        source: "WEBSITE",
        sourceDetail: `simplerms:${l.source ?? "unknown"}`,
        email,
        firstName,
        lastName,
        phone: l.phone ?? null,
      },
    });
    bump("Lead", "created");
  }
}

async function main() {
  await source.connect();
  console.log(`simplerms -> Holt migration ${DRY_RUN ? "(DRY RUN — no writes)" : ""}`);

  await migrateCustomers();
  await migrateServices();
  await migrateInvoices();
  await backfillLedger();
  await migrateTickets();
  await migrateAppointments();
  await migrateTimeEntries();
  await migrateLeads();

  // Skipped on purpose; recorded so nothing silently disappears.
  const files = await source.query('SELECT count(*)::int AS n FROM "File"');
  if (files.rows[0].n > 0) {
    except("File", "(all)", "count — copy data/uploads manually + remap paths", files.rows[0].n);
  }
  const cms = await source.query(
    'SELECT (SELECT count(*)::int FROM "CmsPage") AS pages, (SELECT count(*)::int FROM "CmsPost") AS posts',
  );
  console.log(
    `CMS skipped by design (akritos seed is canonical): ${cms.rows[0].pages} pages, ${cms.rows[0].posts} posts in source.`,
  );

  console.log("\nPer-entity counts:");
  console.log(JSON.stringify(counts, null, 2));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const out = path.join(here, "migration-exceptions.json");
  fs.writeFileSync(out, JSON.stringify(exceptions, null, 2));
  console.log(`\n${exceptions.length} exception rows written to ${out}`);
  if (!DRY_RUN) {
    console.log(
      "\nNext: run the AR drift check (POST /api/automations/customer-ar-drift-check) to verify the subledger ties out.",
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await source.end().catch(() => {});
    await prisma.$disconnect();
  });
