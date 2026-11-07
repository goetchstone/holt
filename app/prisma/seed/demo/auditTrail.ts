// /app/prisma/seed/demo/auditTrail.ts
//
// What Admin > Audit Trail shows for the actions with no history of their own
// (GAP-29). The rest of the list comes from the histories the seed already fills,
// like an order's changes and stock moves. A demo store has been running for a while,
// so it shows someone having done each kind of thing. Draws no RNG.

import type { PrismaClient } from "@prisma/client";
import type { AuditEvent } from "@/lib/auditCatalog";

const HOUR = 60 * 60 * 1000;

const ENTRIES: { hoursAgo: number; event: AuditEvent; actor: string; summary: string }[] = [
  {
    hoursAgo: 3,
    event: "PRODUCT_PRICE_CHANGED",
    actor: "admin@example.com",
    summary: "Harbor Sofa: retail 1899 → 1749",
  },
  {
    hoursAgo: 27,
    event: "SETTINGS_SAVED",
    actor: "owner@example.com",
    summary: "Changed: followUpEmailHour, lowStockAlertHour",
  },
  {
    hoursAgo: 50,
    event: "DATA_EXPORTED",
    actor: "admin@example.com",
    summary: "Customer email list exported: 212 addresses",
  },
  {
    hoursAgo: 74,
    event: "ROLE_CHANGED",
    actor: "owner@example.com",
    summary: 'Role "Store Manager": 1 permissions added, 0 taken away',
  },
  {
    hoursAgo: 98,
    event: "STAFF_CHANGED",
    actor: "owner@example.com",
    summary: "A new designer added as DESIGNER",
  },
  {
    hoursAgo: 146,
    event: "TAX_CHANGED",
    actor: "admin@example.com",
    summary: "Tax rule 1 changed",
  },
  {
    hoursAgo: 194,
    event: "DATABASE_BACKUP_DOWNLOADED",
    actor: "owner@example.com",
    summary: "Whole database downloaded as a backup",
  },
];

export async function seedAuditTrail(prisma: PrismaClient, now: Date): Promise<number> {
  const { count } = await prisma.auditEntry.createMany({
    data: ENTRIES.map(({ hoursAgo, ...entry }) => ({
      ...entry,
      created: new Date(now.getTime() - hoursAgo * HOUR),
    })),
  });
  return count;
}
