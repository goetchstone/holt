// /app/src/lib/audit.ts
//
// Records who did something sensitive (GAP-29, DECISIONS 50). It goes in AuditEntry,
// so Admin > Audit Trail can answer "who did this", and in the application log.
//
// Never put a secret in `details`, or a card's barcode: this is read on a screen.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logError, logger } from "@/lib/logger";
import type { AuditEvent } from "@/lib/auditCatalog";

export type { AuditEvent } from "@/lib/auditCatalog";

export interface AuditFacts {
  /** One line for the screen: what happened, in the store's words. */
  summary: string;
  /** What it was done to, when that still exists: lib/auditFeed.ts links to it. */
  target?: { type: AuditTargetType; id: string | number };
  details?: Prisma.InputJsonObject;
}

export type AuditTargetType = "order" | "customer" | "product" | "staff" | "vendor" | "role";

/**
 * Inside a transaction, pass it: the entry then stands or falls with the action, so
 * an action can't happen with no record of who did it. Outside one, the action has
 * already happened, so a failed write is logged and doesn't undo or fail it.
 */
export async function auditLog(
  event: AuditEvent,
  actor: string,
  facts: AuditFacts,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  logger.info(`Audit: ${event}`, {
    audit: true,
    event,
    actor,
    summary: facts.summary,
    ...facts.details,
  });
  const data: Prisma.AuditEntryCreateInput = {
    event,
    actor,
    summary: facts.summary,
    targetType: facts.target?.type ?? null,
    targetId: facts.target === undefined ? null : String(facts.target.id),
    details: facts.details,
  };
  if (tx) {
    await tx.auditEntry.create({ data });
    return;
  }
  try {
    await prisma.auditEntry.create({ data });
  } catch (err) {
    logError(`Couldn't record audit event ${event}`, err);
  }
}

/** Who's doing this, from a route's session. */
export function auditActor(
  session: { user?: { email?: string | null } | null } | null | undefined,
): string {
  return session?.user?.email ?? "unknown";
}

/** The names of the fields in `after` that differ from `before`. Never their values. */
export function changedFieldNames(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  // A Decimal reads back as "1.5" where a form sends 1.5, and that's no change.
  const comparable = (value: unknown) => JSON.stringify(value ?? null).replace(/^"|"$/g, "");
  return Object.keys(after).filter(
    (field) => after[field] !== undefined && comparable(before[field]) !== comparable(after[field]),
  );
}
