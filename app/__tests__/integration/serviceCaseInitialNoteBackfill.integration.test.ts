// /app/__tests__/integration/serviceCaseInitialNoteBackfill.integration.test.ts
//
// Real-DB test for `20260527b_backfill_service_case_initial_note_dates`.
// Recovery path for owners who imported under PRs #335 or earlier and
// have wrong-dated initial-issue notes (and case.created) in their DB.
//
// What we're protecting:
//   - The migration pulls initial-issue notes BACK to the earliest
//     threaded comment date for the same case.
//   - The matching ServiceCase.created moves too, so the "Opened"
//     date the UI shows lines up with the note date.
//   - Native ERP cases (no cs-sheet externalSource) are NOT touched.
//   - The migration is idempotent — re-running it leaves the same
//     state.

import { Client } from "pg";
import path from "node:path";
import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";

const MIGRATION_PATH = path.join(
  __dirname,
  "..",
  "..",
  "prisma",
  "migrations",
  "20260527b_backfill_service_case_initial_note_dates",
  "migration.sql",
);

async function runMigration(): Promise<void> {
  // The Prisma migrations engine isn't bound to the test DB at runtime;
  // replay the file directly. Same pattern as paymentDeleteImmutability.
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const sql = fs.readFileSync(MIGRATION_PATH, "utf-8");
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function seedBaselineTaxonomy() {
  await prisma.serviceCaseStatus.upsert({
    where: { name: "Open" },
    update: {},
    create: { name: "Open", isClosed: false, sortOrder: 1 },
  });
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

async function seedWrongDatedCase(opts: {
  caseRowKey: string;
  caseCreated: Date;
  initialCreated: Date;
  threadedDates: Date[];
}) {
  const status = await prisma.serviceCaseStatus.findFirst({ where: { name: "Open" } });
  const type = await prisma.serviceCaseType.findFirst({ where: { name: "Other" } });
  const priority = await prisma.serviceCasePriority.findFirst({ where: { name: "Normal" } });
  const c = await prisma.serviceCase.create({
    data: {
      caseNumber: `CSI-${opts.caseRowKey.slice(0, 8).toUpperCase()}`,
      summary: "seeded test case",
      typeId: type!.id,
      statusId: status!.id,
      priorityId: priority!.id,
      externalSource: "cs-sheet",
      externalSourceId: `cs-sheet:${opts.caseRowKey}`,
      created: opts.caseCreated,
    },
  });
  // Initial note (wrong-dated).
  await prisma.serviceCaseNote.create({
    data: {
      caseId: c.id,
      note: "issue text",
      isInternal: true,
      externalSource: "cs-sheet",
      externalSourceId: `cs-sheet-note:initial:cs-sheet:${opts.caseRowKey}`,
      created: opts.initialCreated,
      authorDisplayName: "(initial)",
    },
  });
  // Threaded comments (correct dates).
  for (let i = 0; i < opts.threadedDates.length; i++) {
    await prisma.serviceCaseNote.create({
      data: {
        caseId: c.id,
        note: `threaded ${i}`,
        isInternal: true,
        externalSource: "cs-sheet",
        externalSourceId: `cs-sheet-note:guid-${opts.caseRowKey}-${i}`,
        created: opts.threadedDates[i],
        authorDisplayName: "Rebecca Warren",
      },
    });
  }
  return c.id;
}

describe("20260527b_backfill_service_case_initial_note_dates (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
    await seedBaselineTaxonomy();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("pulls initial-issue note's `created` back to the earliest threaded comment", async () => {
    const caseId = await seedWrongDatedCase({
      caseRowKey: "abc123",
      caseCreated: new Date("2026-05-27T10:30:00Z"), // today, wrong
      initialCreated: new Date("2026-05-27T10:30:00Z"), // today, wrong
      threadedDates: [
        new Date("2025-10-02T18:26:30Z"),
        new Date("2025-11-15T14:00:00Z"),
        new Date("2026-01-20T09:00:00Z"),
      ],
    });

    await runMigration();

    const c = await prisma.serviceCase.findUnique({
      where: { id: caseId },
      include: { notes: { orderBy: { created: "asc" } } },
    });
    expect(c).not.toBeNull();
    const initial = c!.notes.find((n) => n.externalSourceId?.startsWith("cs-sheet-note:initial:"));
    expect(initial).toBeDefined();
    // Pulled back to the earliest threaded comment.
    expect(initial!.created.toISOString()).toBe("2025-10-02T18:26:30.000Z");
    // Case.created moved too.
    expect(c!.created.toISOString()).toBe("2025-10-02T18:26:30.000Z");
  });

  it("does NOT touch a case where the initial note is ALREADY before the earliest threaded comment", async () => {
    const earlyInitial = new Date("2025-09-01T00:00:00Z");
    const caseId = await seedWrongDatedCase({
      caseRowKey: "alreadyok",
      caseCreated: earlyInitial,
      initialCreated: earlyInitial,
      threadedDates: [new Date("2025-10-02T18:26:30Z")],
    });

    await runMigration();

    const c = await prisma.serviceCase.findUnique({
      where: { id: caseId },
      include: { notes: { orderBy: { created: "asc" } } },
    });
    const initial = c!.notes.find((n) => n.externalSourceId?.startsWith("cs-sheet-note:initial:"));
    expect(initial!.created.toISOString()).toBe(earlyInitial.toISOString());
    expect(c!.created.toISOString()).toBe(earlyInitial.toISOString());
  });

  it("does NOT touch a case with no threaded comments (the legitimate today-fallback case)", async () => {
    // Case has only the initial note + no threaded comments. The
    // initial date might be today legitimately (no other signal).
    // The migration's join finds no min_created → no update.
    const wrongDate = new Date("2026-05-27T10:30:00Z");
    const caseId = await seedWrongDatedCase({
      caseRowKey: "nothreaded",
      caseCreated: wrongDate,
      initialCreated: wrongDate,
      threadedDates: [],
    });

    await runMigration();

    const c = await prisma.serviceCase.findUnique({
      where: { id: caseId },
      include: { notes: true },
    });
    // No threaded comments → no signal → stays as imported.
    expect(c!.created.toISOString()).toBe(wrongDate.toISOString());
    expect(c!.notes[0].created.toISOString()).toBe(wrongDate.toISOString());
  });

  it("does NOT touch native ERP cases (no cs-sheet externalSource)", async () => {
    const status = await prisma.serviceCaseStatus.findFirst({ where: { name: "Open" } });
    const type = await prisma.serviceCaseType.findFirst({ where: { name: "Other" } });
    const priority = await prisma.serviceCasePriority.findFirst({ where: { name: "Normal" } });
    const nativeCase = await prisma.serviceCase.create({
      data: {
        caseNumber: "ERP-001",
        summary: "native case",
        typeId: type!.id,
        statusId: status!.id,
        priorityId: priority!.id,
        created: new Date("2026-05-27T10:30:00Z"),
        // No externalSource — this is a native ERP-created case.
      },
    });
    // Add a note that happens to look like a cs-sheet threaded comment
    // (but ISN'T marked with externalSource). The migration should
    // ignore the whole case because the case's externalSource is null.
    await prisma.serviceCaseNote.create({
      data: {
        caseId: nativeCase.id,
        note: "manual note",
        isInternal: true,
        created: new Date("2025-01-01T00:00:00Z"),
      },
    });

    const beforeCreated = (await prisma.serviceCase.findUnique({ where: { id: nativeCase.id } }))!
      .created;
    await runMigration();
    const afterCreated = (await prisma.serviceCase.findUnique({ where: { id: nativeCase.id } }))!
      .created;
    expect(afterCreated.toISOString()).toBe(beforeCreated.toISOString());
  });

  it("is idempotent — running the migration twice leaves the same state", async () => {
    const caseId = await seedWrongDatedCase({
      caseRowKey: "idempotent",
      caseCreated: new Date("2026-05-27T10:30:00Z"),
      initialCreated: new Date("2026-05-27T10:30:00Z"),
      threadedDates: [new Date("2025-10-02T18:26:30Z")],
    });
    await runMigration();
    const afterFirst = await prisma.serviceCase.findUnique({
      where: { id: caseId },
      include: { notes: { orderBy: { created: "asc" } } },
    });
    await runMigration();
    const afterSecond = await prisma.serviceCase.findUnique({
      where: { id: caseId },
      include: { notes: { orderBy: { created: "asc" } } },
    });
    expect(afterSecond!.created.toISOString()).toBe(afterFirst!.created.toISOString());
    expect(afterSecond!.notes[0].created.toISOString()).toBe(
      afterFirst!.notes[0].created.toISOString(),
    );
  });
});
