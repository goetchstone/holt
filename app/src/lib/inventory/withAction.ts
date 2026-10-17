// /app/src/lib/inventory/withAction.ts
//
// A handheld action done once, however many times it is sent (ledger plan
// phase 4, built with the handheld pages that need it). A scanner on bad
// Wi-Fi resends: the request reached the server, the answer did not reach the
// scanner. Each action carries a key the device chose for it; the first
// request with that key does the work and records its answer, and every later
// one gets that answer back without moving anything again.
//
// The key row is inserted first, in the same transaction as the work. Two
// copies of one action racing each other: the second insert waits on the
// first's, then finds the row and returns its answer. If the first rolls
// back, so does its row, and the second does the work.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type Tx = Prisma.TransactionClient;

export class ActionKeyError extends Error {}

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

/** A request's action key, or a 400 message when it is missing or malformed. */
export function parseActionKey(value: unknown): string | ActionKeyError {
  if (typeof value === "string" && KEY_PATTERN.test(value)) return value;
  return new ActionKeyError(
    "actionKey is required: 8 to 100 letters, digits, '-' or '_', new for each action.",
  );
}

export async function withAction<T>(
  key: string,
  opts: { kind: string; actor?: string | null },
  fn: (tx: Tx, actionKey: string) => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  if (!KEY_PATTERN.test(key)) throw new ActionKeyError("That action key is not valid.");
  return prisma.$transaction(async (tx) => {
    const inserted = await tx.$executeRaw`
        INSERT INTO "StockAction" ("key", "kind", "actor", "created")
        VALUES (${key}, ${opts.kind}, ${opts.actor ?? null}, now())
        ON CONFLICT ("key") DO NOTHING`;
    if (inserted === 0) {
      const prior = await tx.stockAction.findUniqueOrThrow({ where: { key } });
      return { result: prior.result as T, replayed: true };
    }
    const result = await fn(tx, key);
    await tx.stockAction.update({
      where: { key },
      data: { result: JSON.parse(JSON.stringify(result ?? null)) as Prisma.InputJsonValue },
    });
    return { result, replayed: false };
  });
}
