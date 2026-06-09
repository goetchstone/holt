// /app/__tests__/integration/runServiceCaseSheetImport.integration.test.ts
//
// Real-DB tests for the Customer Service Sheet → ServiceCase importer.
//
// What we're protecting:
//
//   1. Idempotency — re-running the same buffer is a no-op.
//   2. Customer / SalesOrder matching pulls the right FKs onto the
//      created ServiceCase row.
//   3. Status mapping creates the case under the correct
//      ServiceCaseStatus (including the two new statuses seeded by
//      the 20260526 migration: "Service Call", "Needs Attention").
//   4. Notes — the cell-value "Initial Issue" becomes one note row;
//      re-imports don't duplicate it.
//   5. Dry-run mode counts WOULD-happen actions without writing.
//   6. Unmatched customers are surfaced on `result.unmatched` so the
//      operator can reconcile.
//
// XLSX threaded-comment parsing is covered fully by the unit tests
// in __tests__/serviceCaseSheetImport.test.ts (the XML decoding is
// pure). This integration test builds workbook fixtures via sheetjs
// (no threaded comments) and exercises the DB-coupled orchestration
// path.

import * as XLSX from "xlsx";
import { unzipSync, zipSync, strToU8 } from "fflate";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { runServiceCaseSheetImport } from "@/lib/runServiceCaseSheetImport";

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

/** Minimal shape for a threaded comment to inject into the xlsx zip. */
interface FixtureThreadedComment {
  /** Cell ref the comment anchors to (e.g. "K2" for row 2 of the In-Process tab). */
  ref: string;
  /** ISO-ish timestamp matching the dT format Excel emits ("2025-12-03T19:19:55.00"). */
  dt: string;
  /** Author display name. Embedded in person.xml so the parser can resolve it. */
  author: string;
  /** Comment text. */
  text: string;
}

interface FixtureRow {
  Timestamp?: Date;
  Name: string;
  "Phone #"?: string;
  Email?: string;
  "Preferred Contact Method"?: string;
  Vendor?: string;
  Status?: string;
  "Order #"?: string;
  "Item #"?: string;
  Designer?: string;
  "Initial Issue, Status Update, and Notes"?: string;
}

interface BuildArgs {
  inProcess?: FixtureRow[];
  completed?: FixtureRow[];
  /**
   * Optional threaded comments to inject into the In-Process sheet's
   * `xl/threadedComments/threadedComment1.xml` part. Adds the matching
   * rels + person.xml so the parser sees them end-to-end.
   */
  inProcessThreadedComments?: FixtureThreadedComment[];
}

function buildWorkbookBuffer(args: BuildArgs): Buffer {
  const wb = XLSX.utils.book_new();
  const headers = [
    "Timestamp",
    "Name",
    "Phone #",
    "Email",
    "Preferred Contact Method",
    "Vendor",
    "Status",
    "Order #",
    "Item #",
    "Designer",
    "Initial Issue, Status Update, and Notes",
  ];

  function toAoa(rows: FixtureRow[] = []): unknown[][] {
    return [
      headers,
      ...rows.map((r) => headers.map((h) => (r as unknown as Record<string, unknown>)[h] ?? "")),
    ];
  }

  const inProc = XLSX.utils.aoa_to_sheet(toAoa(args.inProcess), { cellDates: true });
  XLSX.utils.book_append_sheet(wb, inProc, "C.S. In process");

  const done = XLSX.utils.aoa_to_sheet(toAoa(args.completed), { cellDates: true });
  XLSX.utils.book_append_sheet(wb, done, "C.S. Completed");

  // Repair tab — we don't exercise it here but it must exist so the
  // SHEETS_TO_IMPORT array doesn't quietly skip a needed sheet later.
  const repair = XLSX.utils.aoa_to_sheet([
    ["Column 1", "Name", "Vendor", "Initial Issue, Status Update, and Notes", "Status"],
  ]);
  XLSX.utils.book_append_sheet(wb, repair, "Repair");

  const baseBuf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const comments = args.inProcessThreadedComments ?? [];
  if (comments.length === 0) return baseBuf;
  return injectThreadedComments(baseBuf, comments);
}

/**
 * Patch the xlsx zip to add threaded comments to the In-Process sheet.
 * Adds:
 *   - `xl/persons/person.xml`            — one person per author
 *   - `xl/threadedComments/threadedComment1.xml` — the comments
 *   - `xl/worksheets/_rels/sheet1.xml.rels` — points sheet1 at TC file
 * The parser keys on threaded-comment `ref` attributes; the cell-comment
 * (commentN.xml / VML) parts aren't required for our parser to find them.
 */
function injectThreadedComments(buf: Buffer, comments: FixtureThreadedComment[]): Buffer {
  const zip = unzipSync(new Uint8Array(buf));
  const authors = [...new Set(comments.map((c) => c.author))];
  const authorIds = new Map(authors.map((a, i) => [a, `{p${i + 1}}`]));

  const personXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<personList xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments" xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\n` +
    authors
      .map(
        (a) =>
          `<person id="${authorIds.get(a)}" displayName="${a.replace(/&/g, "&amp;").replace(/</g, "&lt;")}" providerId="None"/>`,
      )
      .join("\n") +
    `\n</personList>`;

  const tcXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<x18tc:ThreadedComments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:x18tc="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments">\n` +
    comments
      .map(
        (c, i) =>
          `<x18tc:threadedComment ref="${c.ref}" dT="${c.dt}" personId="${authorIds.get(c.author)}" id="{c-${i + 1}}" done="0"><x18tc:text xml:space="preserve">${c.text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</x18tc:text></x18tc:threadedComment>`,
      )
      .join("\n") +
    `\n</x18tc:ThreadedComments>`;

  // The parser finds the threadedComment file via the worksheet's rels.
  // SheetJS-emitted xlsx files don't ship a per-sheet rels file unless
  // there's an external reference; we write one pointing to our TC.
  const sheet1RelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n` +
    `<Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2017/10/relationships/threadedComment" Target="../threadedComments/threadedComment1.xml"/>\n` +
    `</Relationships>`;

  const patched: Record<string, Uint8Array> = { ...zip };
  patched["xl/persons/person.xml"] = strToU8(personXml);
  patched["xl/threadedComments/threadedComment1.xml"] = strToU8(tcXml);
  patched["xl/worksheets/_rels/sheet1.xml.rels"] = strToU8(sheet1RelsXml);
  return Buffer.from(zipSync(patched));
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

async function seedBaselineTaxonomy() {
  // Ensure status / type / priority rows the importer needs.
  const desiredStatuses = [
    { name: "Open", isClosed: false, sortOrder: 1 },
    { name: "Service Call", isClosed: false, sortOrder: 15 },
    { name: "Needs Attention", isClosed: false, sortOrder: 17 },
    { name: "Waiting on Vendor", isClosed: false, sortOrder: 3 },
    { name: "Completed", isClosed: true, sortOrder: 7 },
  ];
  for (const s of desiredStatuses) {
    await prisma.serviceCaseStatus.upsert({
      where: { name: s.name },
      update: {},
      create: { name: s.name, isClosed: s.isClosed, sortOrder: s.sortOrder },
    });
  }
  await prisma.serviceCaseType.upsert({
    where: { name: "Other" },
    update: {},
    create: { name: "Other", sortOrder: 9 },
  });
  await prisma.serviceCasePriority.upsert({
    where: { name: "Normal" },
    update: {},
    create: { name: "Normal", level: 2, sortOrder: 2 },
  });
}

async function seedCustomer(args: {
  firstName: string;
  lastName: string;
  phone?: string;
  email?: string;
}): Promise<number> {
  const c = await prisma.customer.create({
    data: {
      firstName: args.firstName,
      lastName: args.lastName,
      phone: args.phone,
      email: args.email,
    },
  });
  return c.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runServiceCaseSheetImport — real-DB scenarios", () => {
  beforeEach(async () => {
    await resetTestDb();
    await seedBaselineTaxonomy();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates one ServiceCase + one initial-issue note per row", async () => {
    const customerId = await seedCustomer({
      firstName: "Barbara",
      lastName: "Panagy",
      phone: "860-470-3653",
    });

    const buf = buildWorkbookBuffer({
      inProcess: [
        {
          Timestamp: new Date("2025-10-03T00:00:00Z"),
          Name: "Barbara Panagy",
          "Phone #": "860-470-3653",
          "Preferred Contact Method": "Phone",
          Vendor: "Hallagan",
          Status: "Service Call",
          "Initial Issue, Status Update, and Notes":
            "Bought a swivel chair years ago, looking for replacement plastic feet covers.",
        },
      ],
    });

    const result = await runServiceCaseSheetImport(buf);
    expect(result.errors).toEqual([]);
    expect(result.casesCreated).toBe(1);
    expect(result.casesUpdated).toBe(0);
    expect(result.notesCreated).toBe(1); // the initial-issue cell text

    const cases = await prisma.serviceCase.findMany({
      where: { externalSource: "cs-sheet" },
      include: { status: true, notes: true },
    });
    expect(cases).toHaveLength(1);
    expect(cases[0].customerId).toBe(customerId);
    expect(cases[0].status.name).toBe("Service Call");
    expect(cases[0].notes).toHaveLength(1);
    expect(cases[0].notes[0].note).toContain("swivel chair");
    expect(cases[0].caseNumber.startsWith("CSI-")).toBe(true);
  });

  it("matches SalesOrder by orderno (including rewrite suffix)", async () => {
    await seedCustomer({ firstName: "Karen", lastName: "Dwyer" });

    // The orderno cell in the sheet often has multiple shapes mashed
    // together. Verify both straight + " - A" forms resolve.
    await prisma.salesOrder.create({
      data: {
        orderno: "SO-28978 - A",
        orderDate: new Date("2024-01-01"),
        storeLocation: "Main Store",
      },
    });

    const buf = buildWorkbookBuffer({
      inProcess: [
        {
          Timestamp: new Date("2025-10-03T00:00:00Z"),
          Name: "Karen Dwyer",
          "Order #": "PONO6239/ SO-28978-A",
          "Initial Issue, Status Update, and Notes": "Replacing the seat cushion.",
        },
      ],
    });

    const result = await runServiceCaseSheetImport(buf);
    expect(result.casesCreated).toBe(1);
    const cases = await prisma.serviceCase.findMany({
      where: { externalSource: "cs-sheet" },
      include: { salesOrder: true },
    });
    expect(cases[0].salesOrder?.orderno).toBe("SO-28978 - A");
  });

  it("is idempotent — re-running the same buffer creates / updates nothing new", async () => {
    await seedCustomer({ firstName: "Alan", lastName: "Nordquist" });
    const buf = buildWorkbookBuffer({
      inProcess: [
        {
          Timestamp: new Date("2024-05-17T00:00:00Z"),
          Name: "Alan Nordquist",
          Vendor: "Durham",
          Status: "Needs Attention",
          "Initial Issue, Status Update, and Notes": "Bed RAF side won't latch.",
        },
      ],
    });

    const first = await runServiceCaseSheetImport(buf);
    expect(first.casesCreated).toBe(1);
    expect(first.notesCreated).toBe(1);

    const second = await runServiceCaseSheetImport(buf);
    expect(second.casesCreated).toBe(0);
    expect(second.casesUpdated).toBe(1);
    // Initial-issue notes are RE-SYNCED on every import (their text
    // and date come from cells the operator can correct), so they
    // count as notesUpdated rather than notesSkipped. Threaded
    // comments stay immutable but the fixture has none.
    expect(second.notesCreated).toBe(0);
    expect(second.notesUpdated).toBe(1);
    expect(second.notesSkipped).toBe(0);

    // DB still has exactly one case + one note.
    expect(await prisma.serviceCase.count({ where: { externalSource: "cs-sheet" } })).toBe(1);
    expect(await prisma.serviceCaseNote.count({ where: { externalSource: "cs-sheet" } })).toBe(1);
  });

  it("Status updates in the sheet flow through to the ERP on re-import", async () => {
    await seedCustomer({ firstName: "Jen", lastName: "Smith" });

    // First import: case is "Service Call"
    const buf1 = buildWorkbookBuffer({
      inProcess: [
        {
          Timestamp: new Date("2025-10-03T00:00:00Z"),
          Name: "Jen Smith",
          "Order #": "SO-12345",
          Status: "Service Call",
          "Initial Issue, Status Update, and Notes": "Issue",
        },
      ],
    });
    await runServiceCaseSheetImport(buf1);

    // Second import: same row but moved to Completed
    const buf2 = buildWorkbookBuffer({
      inProcess: [],
      completed: [
        {
          Timestamp: new Date("2025-10-03T00:00:00Z"),
          Name: "Jen Smith",
          "Order #": "SO-12345",
          Status: "Completed",
          "Initial Issue, Status Update, and Notes": "Issue",
        },
      ],
    });
    await runServiceCaseSheetImport(buf2);

    // A row that moves from In-process to Completed used to produce
    // TWO cases (different rowKeys per sheet name). Since the
    // 2026-05-28 content-fallback fix, the second import's rowKey
    // lookup misses but the content fallback (customer + order +
    // summary) matches the first import's case and updates its
    // status in place — exactly the cross-sheet merge sweep the old
    // comment promised. ONE case, status = Completed.
    const cases = await prisma.serviceCase.findMany({
      where: { externalSource: "cs-sheet" },
      include: { status: true },
      orderBy: { id: "asc" },
    });
    expect(cases).toHaveLength(1);
    expect(cases[0].status.name).toBe("Completed");
  });

  it("dry-run reports counts without writing", async () => {
    await seedCustomer({ firstName: "Test", lastName: "Customer" });
    const buf = buildWorkbookBuffer({
      inProcess: [
        {
          Timestamp: new Date("2025-10-03T00:00:00Z"),
          Name: "Test Customer",
          "Initial Issue, Status Update, and Notes": "test issue",
        },
      ],
    });

    const result = await runServiceCaseSheetImport(buf, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.casesCreated).toBe(1);
    expect(result.notesCreated).toBe(1);
    expect(await prisma.serviceCase.count()).toBe(0);
    expect(await prisma.serviceCaseNote.count()).toBe(0);
  });

  it("surfaces unmatched customers on result.unmatched", async () => {
    // No customer seeded — the row should still import but flag.
    // SO-99999 won't exist either, so BOTH "Order didn't match"
    // AND "Customer not found" surface (the operator gets both
    // signals for the same row).
    const buf = buildWorkbookBuffer({
      inProcess: [
        {
          Timestamp: new Date("2025-10-03T00:00:00Z"),
          Name: "Ghost Person",
          "Order #": "SO-99999",
          "Initial Issue, Status Update, and Notes": "issue",
        },
      ],
    });

    const result = await runServiceCaseSheetImport(buf);
    expect(result.casesCreated).toBe(1);
    expect(result.unmatched.length).toBeGreaterThanOrEqual(1);
    expect(result.unmatched.some((u) => u.reason.match(/Customer not found/i))).toBe(true);
    // Case still landed — customerId is null per schema (nullable FK).
    const c = await prisma.serviceCase.findFirst({ where: { externalSource: "cs-sheet" } });
    expect(c?.customerId).toBeNull();
  });

  it("matches a PO when the row's Order # contains PONO/PON", async () => {
    await seedCustomer({ firstName: "Stansel", lastName: "Test" });
    const vendor = await prisma.vendor.create({
      data: { name: "Wesley Hall", pricingModel: "FLAT" },
    });
    // Canonical the POS shape — PON + 5-digit zero-padded
    await prisma.purchaseOrder.create({
      data: { poNumber: "PON03630", vendorId: vendor.id, orderDate: new Date("2025-12-01") },
    });

    const buf = buildWorkbookBuffer({
      inProcess: [
        {
          Timestamp: new Date("2026-02-14T00:00:00Z"),
          Name: "Stansel Test",
          // Sheet uses PONO (no zero pad); orchestrator must normalize.
          "Order #": "PONO3630",
          Vendor: "Wesley Hall",
          "Initial Issue, Status Update, and Notes": "WH chair replacement",
        },
      ],
    });

    const result = await runServiceCaseSheetImport(buf);
    expect(result.errors).toEqual([]);
    expect(result.casesCreated).toBe(1);
    const c = await prisma.serviceCase.findFirst({
      where: { externalSource: "cs-sheet" },
      include: { purchaseOrder: true, salesOrder: true },
    });
    expect(c?.purchaseOrder?.poNumber).toBe("PON03630");
    expect(c?.salesOrder).toBeNull();
  });

  it("falls back to the SalesOrder's customer when phone/email/name don't match", async () => {
    // Customer's name in the sheet is a couple-with-slash that the
    // name-based matcher won't resolve.
    const targetCustomer = await seedCustomer({
      firstName: "Penny",
      lastName: "Sigal",
      phone: "203-555-0101",
    });
    await prisma.salesOrder.create({
      data: {
        orderno: "SO-77777",
        orderDate: new Date("2025-09-01"),
        customerId: targetCustomer,
      },
    });

    const buf = buildWorkbookBuffer({
      inProcess: [
        {
          Timestamp: new Date("2025-10-03T00:00:00Z"),
          // Slash-couple name format — won't match Customer.lastName lookup
          Name: "Penny/Steve Sigal",
          // Phone differs from the seeded Penny → can't match by phone either
          "Phone #": "860-999-9999",
          "Order #": "SO-77777",
          "Initial Issue, Status Update, and Notes": "Service request",
        },
      ],
    });

    const result = await runServiceCaseSheetImport(buf);
    expect(result.casesCreated).toBe(1);
    const c = await prisma.serviceCase.findFirst({
      where: { externalSource: "cs-sheet" },
      select: { customerId: true, salesOrderId: true },
    });
    // Customer-by-order fallback fired.
    expect(c?.customerId).toBe(targetCustomer);
    // Order was the path → not in unmatched list
    expect(result.unmatched).toEqual([]);
  });

  it("Order # didn't match anything → row gets flagged with the raw Order # in the reason", async () => {
    await seedCustomer({ firstName: "Some", lastName: "One" });
    const buf = buildWorkbookBuffer({
      inProcess: [
        {
          Timestamp: new Date("2025-10-03T00:00:00Z"),
          Name: "Some One",
          "Order #": "PONO9999999 SO-9999999",
          "Initial Issue, Status Update, and Notes": "issue",
        },
      ],
    });

    const result = await runServiceCaseSheetImport(buf);
    expect(result.casesCreated).toBe(1);
    expect(result.unmatched.some((u) => u.reason.includes("didn't match"))).toBe(true);
    // Case still landed — customerId resolved by name, no orders
    const c = await prisma.serviceCase.findFirst({
      where: { externalSource: "cs-sheet" },
      select: { salesOrderId: true, purchaseOrderId: true, customerId: true },
    });
    expect(c?.salesOrderId).toBeNull();
    expect(c?.purchaseOrderId).toBeNull();
    expect(c?.customerId).not.toBeNull();
  });

  it("ServiceCase.created reflects the row's Timestamp (not now()) — wall-clock day preserved", async () => {
    await seedCustomer({ firstName: "Date", lastName: "Check" });
    // Use a date 8 months in the past — well outside any same-day
    // ambiguity. If the importer wrongly defaulted to now(), the
    // year/month would mismatch.
    const expectedTimestamp = new Date(Date.UTC(2025, 9, 3, 0, 0, 0)); // Oct 3 2025 UTC midnight
    const buf = buildWorkbookBuffer({
      inProcess: [
        {
          Timestamp: expectedTimestamp,
          Name: "Date Check",
          "Order #": "SO-NONE",
          "Initial Issue, Status Update, and Notes": "Date pinning",
        },
      ],
    });

    await runServiceCaseSheetImport(buf);
    const c = await prisma.serviceCase.findFirst({
      where: { externalSource: "cs-sheet" },
      include: { notes: { orderBy: { created: "asc" } } },
    });
    expect(c).not.toBeNull();
    // Wall-clock day MUST be Oct 3, 2025 — regardless of the local
    // timezone the test runs in. The fix (anchorDateOnlyToLocalNoon)
    // shifts UTC-midnight to local-noon so day-rollback can't happen.
    expect(c!.created.getFullYear()).toBe(2025);
    expect(c!.created.getMonth()).toBe(9); // October
    expect(c!.created.getDate()).toBe(3);

    // The initial-issue note inherits the same date.
    expect(c!.notes).toHaveLength(1);
    expect(c!.notes[0].created.getFullYear()).toBe(2025);
    expect(c!.notes[0].created.getDate()).toBe(3);
  });

  it("ServiceCase.created falls back to now() when neither earliest-comment nor row.timestamp is available", async () => {
    // Precedence (revised 2026-05-27): earliest threaded comment >
    // row.timestamp > now. With no comments AND no Timestamp, falls
    // all the way to now. (When ONLY comments exist, case.created
    // takes the earliest comment date; that path is covered by the
    // comment-priority tests at the bottom of this file.)
    //
    // We exercise the fallback by passing `Timestamp: undefined`.
    // SheetJS treats undefined / "" cells as blanks; the parser
    // reads them as undefined and the orchestrator's fallback chain
    // activates.
    await seedCustomer({ firstName: "Fallback", lastName: "Date" });
    const buf = buildWorkbookBuffer({
      inProcess: [
        {
          // Timestamp explicitly omitted — simulates a real-world row
          // where the operator forgot to type the date.
          Name: "Fallback Date",
          "Order #": "SO-NONE",
          "Initial Issue, Status Update, and Notes": "Issue text",
        },
      ],
    });

    const before = Date.now();
    await runServiceCaseSheetImport(buf);
    const after = Date.now();

    const c = await prisma.serviceCase.findFirst({
      where: { externalSource: "cs-sheet" },
    });
    // No timestamp + no threaded comments → falls all the way to
    // now(). Just assert it's within the test window (no day-rollback,
    // no stale-imported-date).
    expect(c!.created.getTime()).toBeGreaterThanOrEqual(before);
    expect(c!.created.getTime()).toBeLessThanOrEqual(after + 1000);
  });

  it("re-importing fixes the case-opened date AND the initial-issue note appears once Timestamp is filled in", async () => {
    // Owner direction 2026-05-27: "I don't care how we do it, I just
    // want the correct dates." Real flow: a case landed without a
    // Timestamp on the first import (so we deliberately DON'T fabricate
    // an initial note with today's date — see post-2026-05-27 follow-up
    // in lib/runServiceCaseSheetImport.ts). The operator fills the
    // Timestamp cell and re-uploads. The case's opened date updates AND
    // an initial-issue note now appears with that real date.
    await seedCustomer({ firstName: "Date", lastName: "Resync" });

    // First import: no Timestamp → case lands with @default(now()) AND
    // no initial-issue note (correct behavior; we don't know the date).
    const buf1 = buildWorkbookBuffer({
      inProcess: [
        {
          // Timestamp omitted on purpose.
          Name: "Date Resync",
          "Order #": "SO-NONE",
          "Initial Issue, Status Update, and Notes": "first import",
        },
      ],
    });
    await runServiceCaseSheetImport(buf1);
    const firstSnapshot = await prisma.serviceCase.findFirst({
      where: { externalSource: "cs-sheet" },
      include: { notes: true },
    });
    expect(firstSnapshot).not.toBeNull();
    // Initial-issue text is preserved on the case's `summary` (visible
    // on the detail page), but NOT as a fake-dated note.
    expect(firstSnapshot!.summary).toContain("first import");
    expect(firstSnapshot!.notes).toHaveLength(0);

    // Second import: Timestamp NOW set to Oct 3, 2025.
    const correctedTimestamp = new Date(Date.UTC(2025, 9, 3, 0, 0, 0));
    const buf2 = buildWorkbookBuffer({
      inProcess: [
        {
          Timestamp: correctedTimestamp,
          Name: "Date Resync",
          "Order #": "SO-NONE",
          "Initial Issue, Status Update, and Notes": "first import",
        },
      ],
    });
    await runServiceCaseSheetImport(buf2);

    const after = await prisma.serviceCase.findFirst({
      where: { externalSource: "cs-sheet" },
      include: { notes: true },
    });
    // Same case (idempotency held).
    expect(after!.id).toBe(firstSnapshot!.id);
    // Case opened date updated to the corrected day.
    expect(after!.created.getFullYear()).toBe(2025);
    expect(after!.created.getMonth()).toBe(9); // October
    expect(after!.created.getDate()).toBe(3);
    // Initial-issue note NOW appears with the corrected date.
    expect(after!.notes).toHaveLength(1);
    expect(after!.notes[0].created.getFullYear()).toBe(2025);
    expect(after!.notes[0].created.getDate()).toBe(3);
  });

  it("re-importing does NOT mutate threaded-comment note dates (those are immutable by GUID)", async () => {
    // This is the safety side of the previous test — the
    // re-syncability is INITIAL-NOTE-ONLY. Threaded comments keep
    // their original posting timestamp. Since the fixture builder
    // doesn't emit threaded comments, we exercise the path by
    // creating a note row directly with the threaded-comment
    // externalSourceId prefix, then re-importing and asserting it
    // didn't change.
    const customerId = await seedCustomer({ firstName: "Threaded", lastName: "Test" });
    const expectedTimestamp = new Date(Date.UTC(2025, 9, 3, 0, 0, 0));
    const buf = buildWorkbookBuffer({
      inProcess: [
        {
          Timestamp: expectedTimestamp,
          Name: "Threaded Test",
          "Order #": "SO-NONE2",
          "Initial Issue, Status Update, and Notes": "Initial",
        },
      ],
    });
    await runServiceCaseSheetImport(buf);
    const c = await prisma.serviceCase.findFirst({
      where: { externalSource: "cs-sheet", customerId },
    });
    expect(c).not.toBeNull();

    // Now hand-insert a "threaded comment" note (mimicking what a
    // real threaded comment would have looked like).
    const threadedDate = new Date(Date.UTC(2025, 9, 5, 14, 30, 0));
    await prisma.serviceCaseNote.create({
      data: {
        caseId: c!.id,
        note: "threaded comment text",
        authorDisplayName: "Some Author",
        externalSource: "cs-sheet",
        externalSourceId: "cs-sheet-note:fake-guid-1234",
        created: threadedDate,
        isInternal: true,
      },
    });

    // Re-import. The orchestrator's pendingNotes won't include the
    // hand-inserted note (the fixture has no threaded comments) but
    // the writeNotes path's existence check would skip it anyway.
    // The point is: even when a threaded-comment note IS in the
    // pendingNotes set, it stays untouched.
    await runServiceCaseSheetImport(buf);

    const threadedAfter = await prisma.serviceCaseNote.findUnique({
      where: { externalSourceId: "cs-sheet-note:fake-guid-1234" },
    });
    expect(threadedAfter?.created.getTime()).toBe(threadedDate.getTime());
    expect(threadedAfter?.note).toBe("threaded comment text");
  });

  it("Completed-sheet rows always resolve to status=Completed regardless of cell value", async () => {
    await seedCustomer({ firstName: "Karen", lastName: "D" });
    const buf = buildWorkbookBuffer({
      completed: [
        {
          Timestamp: new Date("2026-01-12T00:00:00Z"),
          Name: "Karen D",
          "Order #": "SO-A1",
          Status: "Completed",
          "Initial Issue, Status Update, and Notes": "x",
        },
        {
          Timestamp: new Date("2024-05-17T00:00:00Z"),
          Name: "Karen D",
          "Order #": "SO-A2",
          Status: "", // blank — still treated as Completed because it's on the Completed tab
          "Initial Issue, Status Update, and Notes": "y",
        },
      ],
    });

    const result = await runServiceCaseSheetImport(buf);
    expect(result.errors).toEqual([]);
    expect(result.casesCreated).toBe(2);
    const cases = await prisma.serviceCase.findMany({
      where: { externalSource: "cs-sheet" },
      include: { status: true },
    });
    expect(cases.map((c) => c.status.name)).toEqual(["Completed", "Completed"]);
  });

  // -------------------------------------------------------------------
  // Date-handling regression (post-failure 2026-05-27)
  // User report: "The initial date for the comments is showing todays
  // date for a lot if not all the imported services."
  // Root cause: a row with no Timestamp + no threaded comments fell
  // through to `now()`, so the initial-issue note showed today.
  // Fix: don't fabricate a date — skip the initial note entirely when
  // no real source date exists. The initial-issue TEXT survives on
  // the case's `summary` so no information is lost.
  // -------------------------------------------------------------------

  it("row with no Timestamp AND no comments creates the case but NO initial-issue note (no fake 'today' date)", async () => {
    await seedCustomer({ firstName: "No", lastName: "Date" });
    const buf = buildWorkbookBuffer({
      inProcess: [
        {
          // No Timestamp; no threaded comments; just text.
          Name: "No Date",
          "Order #": "SO-NONE",
          "Initial Issue, Status Update, and Notes": "missing dates everywhere",
        },
      ],
    });
    const result = await runServiceCaseSheetImport(buf);
    expect(result.errors).toEqual([]);
    expect(result.casesCreated).toBe(1);
    // Notes counter MUST be zero — we refused to fabricate a date.
    expect(result.notesCreated).toBe(0);

    const c = await prisma.serviceCase.findFirst({
      where: { externalSource: "cs-sheet" },
      include: { notes: true },
    });
    expect(c!.notes).toHaveLength(0);
    // The initial-issue text is still surfaced via `summary`.
    expect(c!.summary).toContain("missing dates everywhere");
  });

  it("re-import cleans up a stale initial-issue note that a prior buggy import landed with now()", async () => {
    // This is the recovery path for owners who already imported the
    // sheet under the buggy version. Manually seed an existing case +
    // a wrong-dated initial note (the shape the prior import created),
    // then re-run the importer with the SAME row but no Timestamp.
    // The stale note must be deleted.
    const customerId = await seedCustomer({ firstName: "Stale", lastName: "Note" });
    // Seed a case with the externalSourceId the importer would compute.
    // The rowKey depends on hashed inputs; the simplest path is to run
    // a first import (which under the new code creates NO note), then
    // INSERT the wrong-dated note manually, then re-run.
    const buf = buildWorkbookBuffer({
      inProcess: [
        {
          Name: "Stale Note",
          "Order #": "SO-NONE",
          "Initial Issue, Status Update, and Notes": "old buggy import",
        },
      ],
    });
    await runServiceCaseSheetImport(buf);
    const caseRow = await prisma.serviceCase.findFirst({
      where: { externalSource: "cs-sheet" },
    });
    expect(caseRow).not.toBeNull();
    expect(caseRow!.externalSourceId).toBeTruthy();

    // Manually plant a wrong-dated initial note (simulating prior import).
    const wrongDate = new Date();
    await prisma.serviceCaseNote.create({
      data: {
        caseId: caseRow!.id,
        note: "old buggy import",
        isInternal: true,
        externalSource: "cs-sheet",
        externalSourceId: `cs-sheet-note:initial:${caseRow!.externalSourceId}`,
        created: wrongDate,
        authorDisplayName: "(initial)",
      },
    });
    // Sanity: the wrong-dated note is now in the DB.
    const beforeCleanup = await prisma.serviceCaseNote.count({
      where: { caseId: caseRow!.id },
    });
    expect(beforeCleanup).toBe(1);

    // Re-import the same row (still no Timestamp, still no comments).
    await runServiceCaseSheetImport(buf);

    // Stale note is gone.
    const afterCleanup = await prisma.serviceCaseNote.count({
      where: { caseId: caseRow!.id },
    });
    expect(afterCleanup).toBe(0);
    // Confirm the seeded customer is the one the case got matched to.
    expect(caseRow!.customerId).toBe(customerId);
  });

  // -------------------------------------------------------------------
  // Comment-priority precedence (owner direction 2026-05-27, post-#335)
  // "the open date should be the same as the earliest date in the
  // comments." When BOTH a Timestamp cell AND threaded comments
  // exist, the earliest comment wins. Many real-world Timestamp cells
  // have typos / Y2K-style wrong years; the comment dates come from
  // Excel's threaded-comment GUIDs and are reliable.
  // -------------------------------------------------------------------

  it("when comments exist, case.created uses earliestComment — even when row.timestamp is also set", async () => {
    await seedCustomer({ firstName: "Comment", lastName: "Wins" });

    // Sheet says case opened 2026-06-15 (a future date — the kind of
    // typo we see in real data). Comments say first activity was on
    // 2025-12-03. Expected outcome: case.created = 2025-12-03.
    const buf = buildWorkbookBuffer({
      inProcess: [
        {
          Timestamp: new Date(Date.UTC(2026, 5, 15, 0, 0, 0)), // typed wrong
          Name: "Comment Wins",
          "Order #": "SO-NONE",
          "Initial Issue, Status Update, and Notes": "Real issue text",
        },
      ],
      inProcessThreadedComments: [
        {
          ref: "K2", // K = column 11 (Initial Issue), row 2 (first data row)
          dt: "2025-12-03T19:19:55.00",
          author: "Rebecca Warren",
          text: "First comment — actual case start",
        },
        {
          ref: "K2",
          dt: "2026-02-04T10:00:00.00",
          author: "Rebecca Warren",
          text: "Later follow-up",
        },
      ],
    });

    const result = await runServiceCaseSheetImport(buf);
    expect(result.errors).toEqual([]);

    const c = await prisma.serviceCase.findFirst({
      where: { externalSource: "cs-sheet" },
      include: { notes: { orderBy: { created: "asc" } } },
    });
    // case.created = earliest comment (2025-12-03), NOT the Timestamp
    // (2026-06-15).
    expect(c!.created.getUTCFullYear()).toBe(2025);
    expect(c!.created.getUTCMonth()).toBe(11); // December (0-indexed)
    expect(c!.created.getUTCDate()).toBe(3);

    // Initial-issue note inherits the same earliest-comment date.
    const initialNote = c!.notes.find((n) => n.authorDisplayName === "(initial)");
    expect(initialNote).toBeDefined();
    expect(initialNote!.created.getUTCFullYear()).toBe(2025);
    expect(initialNote!.created.getUTCMonth()).toBe(11);
    expect(initialNote!.created.getUTCDate()).toBe(3);

    // The 2 threaded-comment notes also landed with their real dT
    // dates (not today, not the Timestamp).
    const threaded = c!.notes.filter((n) => n.authorDisplayName !== "(initial)");
    expect(threaded).toHaveLength(2);
    expect(threaded[0].created.toISOString()).toBe("2025-12-03T19:19:55.000Z");
    expect(threaded[1].created.toISOString()).toBe("2026-02-04T10:00:00.000Z");
  });

  it("when ONLY timestamp exists (no comments), case.created still uses the Timestamp cell", async () => {
    // Regression guard: the swap must not break the no-comments path.
    await seedCustomer({ firstName: "Timestamp", lastName: "Only" });
    const buf = buildWorkbookBuffer({
      inProcess: [
        {
          Timestamp: new Date(Date.UTC(2025, 9, 3, 0, 0, 0)),
          Name: "Timestamp Only",
          "Order #": "SO-NONE",
          "Initial Issue, Status Update, and Notes": "No threaded comments",
        },
      ],
      // No inProcessThreadedComments — only the Timestamp signal exists.
    });
    await runServiceCaseSheetImport(buf);
    const c = await prisma.serviceCase.findFirst({
      where: { externalSource: "cs-sheet" },
      include: { notes: true },
    });
    expect(c!.created.getFullYear()).toBe(2025);
    expect(c!.created.getMonth()).toBe(9); // October
    expect(c!.created.getDate()).toBe(3);
    // Initial-issue note also lands at the Timestamp date (its
    // precedence chain mirrors case.created).
    expect(c!.notes).toHaveLength(1);
    expect(c!.notes[0].created.getDate()).toBe(3);
  });

  it("invariant: initial-issue note's `created` is NEVER newer than the earliest threaded comment", async () => {
    // Owner direction 2026-05-27: "there is no logical way the
    // initial can be newer than the next comment." The initial-issue
    // text is the form-submission content that opens the case — it
    // logically predates any follow-up commentary. After PR #337's
    // precedence swap, this invariant should hold for every imported
    // case that has threaded comments.
    await seedCustomer({ firstName: "Invariant", lastName: "Check" });
    const buf = buildWorkbookBuffer({
      inProcess: [
        {
          Timestamp: new Date(Date.UTC(2026, 5, 1, 0, 0, 0)), // intentionally LATE
          Name: "Invariant Check",
          "Order #": "SO-NONE",
          "Initial Issue, Status Update, and Notes": "issue text",
        },
      ],
      inProcessThreadedComments: [
        { ref: "K2", dt: "2025-09-15T08:00:00.00", author: "Tester", text: "first" },
        { ref: "K2", dt: "2025-10-04T08:00:00.00", author: "Tester", text: "second" },
        { ref: "K2", dt: "2025-11-12T08:00:00.00", author: "Tester", text: "third" },
      ],
    });

    await runServiceCaseSheetImport(buf);
    const c = await prisma.serviceCase.findFirst({
      where: { externalSource: "cs-sheet" },
      include: { notes: { orderBy: { created: "asc" } } },
    });
    expect(c).not.toBeNull();
    const initial = c!.notes.find((n) => n.authorDisplayName === "(initial)");
    expect(initial).toBeDefined();
    const threaded = c!.notes.filter((n) => n.authorDisplayName !== "(initial)");
    const earliestThreaded = threaded[0].created.getTime();
    // THE invariant. If this fails, PR #337's precedence swap regressed
    // or the orchestrator started fabricating a now()-style date again.
    expect(initial!.created.getTime()).toBeLessThanOrEqual(earliestThreaded);
    // Same invariant applied to case.created.
    expect(c!.created.getTime()).toBeLessThanOrEqual(earliestThreaded);
  });

  it("content-based fallback prevents duplicate cases across rowKey schema changes", async () => {
    // Origin: PR #331 hashed the Timestamp cell into the rowKey; PR
    // #335 dropped it. A re-import after the schema change created
    // a brand-new case row for every physical sheet row even though
    // the row already existed (366 dup groups, 738/742 affected
    // cases in the 2026-05-28 backup). This test simulates that
    // path by manually retagging a case with a stale externalSourceId
    // and confirming the next import finds it via the content
    // fallback + updates its rowKey to the current value.
    await seedCustomer({ firstName: "Stale", lastName: "Key" });
    const buf = buildWorkbookBuffer({
      inProcess: [
        {
          Timestamp: new Date(Date.UTC(2025, 10, 1, 0, 0, 0)),
          Name: "Stale Key",
          "Order #": "SO-NONE",
          "Initial Issue, Status Update, and Notes": "the only initial issue text",
        },
      ],
    });

    // First import: case created with current rowKey.
    const first = await runServiceCaseSheetImport(buf);
    expect(first.casesCreated).toBe(1);
    const original = await prisma.serviceCase.findFirstOrThrow({
      where: { externalSource: "cs-sheet" },
    });

    // Simulate the "schema change" — rewrite the rowKey so the next
    // import's findUnique lookup misses on the current value.
    await prisma.serviceCase.update({
      where: { id: original.id },
      data: { externalSourceId: "cs-sheet:STALE_LEGACY_HASH" },
    });

    // Second import: rowKey lookup misses, but the content fallback
    // hits → case is updated in place AND its externalSourceId is
    // refreshed to the current rowKey.
    const second = await runServiceCaseSheetImport(buf);
    expect(second.casesCreated).toBe(0);
    expect(second.casesUpdated).toBe(1);
    expect(await prisma.serviceCase.count({ where: { externalSource: "cs-sheet" } })).toBe(1);

    const refreshed = await prisma.serviceCase.findUnique({ where: { id: original.id } });
    expect(refreshed?.externalSourceId).not.toBe("cs-sheet:STALE_LEGACY_HASH");
    expect(refreshed?.externalSourceId).toMatch(/^cs-sheet:/);
  });
});
