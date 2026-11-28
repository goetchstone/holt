// /app/src/lib/tillLock.ts
//
// The till's row lock, for two things that must not cross: money being booked
// against a till, and that till closing.
//
// Closing adds up everything booked against the till to work out what cash
// should be in the drawer. A payment or refund booked at the same moment was
// either missed by that sum or landed on a till already closed, and the
// recorded over/short was wrong by its amount: enough, past $100, to block the
// register for a difference that did not exist. Two closes at once both went
// through, the second replacing the first's count.
//
//   - Whatever books money against a till takes its row FOR SHARE and checks
//     it is OPEN (lockOpenTill). Any number can hold it together.
//   - Closing and reconciling take the row FOR UPDATE (lockTillForChange),
//     which waits for every booking in flight and makes later ones wait.
//
// Each side then reads what the other committed. Both are called first in
// their transaction, so neither waits for the other while holding something
// the other needs.

import type { Prisma, Till } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/** The till is not OPEN, so nothing more can be booked against it. */
export class TillNotOpenError extends Error {
  constructor(
    readonly tillId: number,
    readonly status: string,
  ) {
    super(`Till ${tillId} is not open (status: ${status})`);
    this.name = "TillNotOpenError";
  }
}

/**
 * Hold a till open for the rest of this transaction, for a row about to be
 * booked against it. Waits for a close in progress, then throws
 * TillNotOpenError if the till is no longer OPEN.
 */
export async function lockOpenTill(tx: Tx, tillId: number): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Till" WHERE id = ${tillId} FOR SHARE`;
  const till = await tx.till.findUniqueOrThrow({
    where: { id: tillId },
    select: { status: true },
  });
  if (till.status !== "OPEN") throw new TillNotOpenError(tillId, till.status);
}

/**
 * Take a till for a change of status, for the rest of this transaction, and
 * read it as it stands once everything booked against it has committed. Null
 * when there is no such till.
 */
export async function lockTillForChange(tx: Tx, tillId: number): Promise<Till | null> {
  await tx.$queryRaw`SELECT id FROM "Till" WHERE id = ${tillId} FOR UPDATE`;
  return tx.till.findUnique({ where: { id: tillId } });
}
