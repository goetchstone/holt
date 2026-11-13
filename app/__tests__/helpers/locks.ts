// /app/__tests__/helpers/locks.ts
//
// Putting two requests into a race on purpose, against a real database. A test holds a row
// (`holdRows`), starts the requests, waits until Postgres says they are queued on locks
// (`waitForLockWaits`), and lets go: each request has done its reads by then, so a guard that
// reads without a lock is caught every time, not one run in ten. Nothing in the code under
// test is stubbed or slowed; the only thing the test controls is a row lock of its own.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Lock the rows `sql` selects (it ends `FOR UPDATE`) in a transaction of the test's own, until
 * `release()` is called. Anything else that writes those rows waits on the test meanwhile.
 */
export async function holdRows(sql: Prisma.Sql): Promise<{ release: () => Promise<void> }> {
  let letGo!: () => void;
  const released = new Promise<void>((resolve) => (letGo = resolve));
  let held!: () => void;
  const holding = new Promise<void>((resolve) => (held = resolve));
  const done = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw(sql);
      held();
      await released;
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
  await Promise.race([holding, done]);
  return {
    release: async () => {
      letGo();
      await done;
    },
  };
}

/**
 * Wait until `count` sessions on this database are queued on a lock (a row or an advisory
 * lock), or `withinMs` passes. Returns how many there were: the test's assertions decide what
 * that means, so a request that wasn't held up at all doesn't fail here for the wrong reason.
 */
export async function waitForLockWaits(count: number, withinMs = 5_000): Promise<number> {
  const until = Date.now() + withinMs;
  let waiting = 0;
  while (Date.now() < until) {
    const [row] = await prisma.$queryRaw<{ waiting: bigint }[]>`
      SELECT count(*) AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    waiting = Number(row.waiting);
    if (waiting >= count) return waiting;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return waiting;
}
