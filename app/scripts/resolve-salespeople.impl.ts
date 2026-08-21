// /app/scripts/resolve-salespeople.impl.ts
//
// Gives a StaffMember record to every imported salesperson who never got one,
// then links their orders.
//
// The gap is historical: reporting was designer-only, so people selling from
// Apparel or the Home Shop were never entered as staff -- while their names went
// on every order they wrote. In the reference dataset that is 34 names across
// 13,931 orders, including one seller with $2.4M unattributed. Mixed in are POS
// terminal logins, which are not people and must never become staff.
//
// Amy Sage DeMik is the target shape: archived StaffMember, all 689 orders
// FK-linked. This script produces that shape for everyone else.
//
// DRY RUN BY DEFAULT. It prints what it would create and changes nothing until
// --apply. Writes are guarded by the same rule-59 check the seed uses, so the
// restored databases need an explicit --force-unsafe-db.

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { assertSafeSeedTarget, UnsafeSeedTargetError } from "../prisma/seed/demo/guard";
import { backfillSalesPersonFk } from "@/lib/salesPersonFkBackfill";
import { classifySalesperson, staffRecordFor, type Classification } from "@/lib/staffAttribution";

interface Row {
  name: string;
  orderCount: number;
  lastOrderDate: Date;
}

async function unresolved(prisma: PrismaClient): Promise<Row[]> {
  const rows = await prisma.$queryRaw<{ name: string; n: bigint; last: Date }[]>`
    SELECT so.salesperson AS name, count(*)::bigint AS n, max(so."orderDate") AS last
    FROM "SalesOrder" so
    WHERE so."salesPersonId" IS NULL
      AND so.salesperson IS NOT NULL
      AND btrim(so.salesperson) <> ''
    GROUP BY so.salesperson
    ORDER BY count(*) DESC
  `;
  return rows.map((r) => ({ name: r.name, orderCount: Number(r.n), lastOrderDate: r.last }));
}

/** Deterministic, collision-checked local part; these staff have no real email. */
function emailFor(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ".")
      .replace(/^\.|\.$/g, "") || "unknown";
  let local = base;
  let n = 2;
  while (taken.has(local)) local = `${base}${n++}`;
  taken.add(local);
  return `${local}@imported.invalid`;
}

function print(classifications: { c: Classification; row: Row }[]): void {
  const by = (k: string) => classifications.filter((x) => x.c.kind === k);
  for (const kind of ["active-person", "departed-person", "terminal"] as const) {
    const group = by(kind);
    if (!group.length) continue;
    const orders = group.reduce((s, g) => s + g.row.orderCount, 0);
    const verb =
      kind === "terminal" ? "left alone (not people)" : `to create as ${kind.split("-")[0]}`;
    console.log(`\n${group.length} ${verb} — ${orders} orders`);
    for (const { c, row } of group) {
      console.log(
        `  ${row.name.padEnd(24)} ${String(row.orderCount).padStart(5)} orders   ${c.rationale}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const url = process.env.DATABASE_URL ?? "";

  if (apply) {
    // Only checked when writing: a dry run against restored data is exactly how
    // you decide whether to run this at all.
    assertSafeSeedTarget(url, {
      forceUnsafe:
        argv.includes("--force-unsafe-db") || process.env.HOLT_SEED_FORCE_UNSAFE_DB === "1",
    });
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const rows = await unresolved(prisma);
    if (!rows.length) {
      console.log("Every order with a salesperson name is already linked to a StaffMember.");
      return;
    }
    const today = new Date();
    const classified = rows.map((row) => ({ row, c: classifySalesperson(row, today) }));
    print(classified);

    if (!apply) {
      console.log(
        `\nDry run — nothing written. Re-run with --apply to create ` +
          `${classified.filter((x) => x.c.kind !== "terminal").length} staff records and link their orders.`,
      );
      return;
    }

    const existing = await prisma.staffMember.findMany({ select: { email: true } });
    const taken = new Set(existing.map((e) => e.email?.split("@")[0]).filter(Boolean) as string[]);

    let created = 0;
    for (const { row, c } of classified) {
      const record = staffRecordFor(c);
      if (!record) continue;
      // displayName is what the orders carry, so the existing backfill matches
      // on it without needing an alias.
      const already = await prisma.staffMember.findFirst({
        where: { displayName: { equals: row.name, mode: "insensitive" } },
        select: { id: true },
      });
      if (already) continue;
      await prisma.staffMember.create({
        data: {
          displayName: row.name,
          email: emailFor(row.name, taken),
          role: record.role,
          isDesigner: record.isDesigner,
          isActive: record.isActive,
        },
      });
      created++;
    }
    const { updated } = await backfillSalesPersonFk(prisma);
    console.log(`\nCreated ${created} staff records; linked ${updated} orders.`);

    const left = await unresolved(prisma);
    const stillPeople = left.filter((r) => staffRecordFor(classifySalesperson(r, today)) !== null);
    console.log(
      `Remaining unlinked: ${left.reduce((s, r) => s + r.orderCount, 0)} orders across ` +
        `${left.length} names (${stillPeople.length} of them people — expected 0).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  if (e instanceof UnsafeSeedTargetError) {
    console.error(String(e.message));
    process.exit(1);
  }
  throw e;
});
