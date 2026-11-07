// /app/jest.integration.afterEach.ts
//
// After every integration test: stock and its journal must agree.
//
// lib/inventory/ledger.ts writes every change to InventoryPosition together
// with a StockMovement row, and ledgerDrift() lists every place where the
// balance is not the journal's sum. Running it here, for every test in every
// suite, means a code path that changes stock without the journal fails the
// suite that exercises it, whether or not that suite thought to check (rule 65:
// a gate that runs unattended). Fixtures put stock in place with
// __tests__/helpers/stock.ts for the same reason.

import { prisma } from "@/lib/prisma";
import { ledgerDrift } from "@/lib/inventory/ledger";

// Resetting the database before each test is real work across about 200 tables, and
// five seconds wasn't always enough on a busy CI runner or a loaded machine: unrelated
// suites failed on it. A test that really hangs still fails, just later.
jest.setTimeout(20_000);

afterEach(async () => {
  const drift = await ledgerDrift(prisma);
  if (drift.length > 0) {
    throw new Error(
      `Stock and its journal disagree at ${drift.length} place(s) after this test. ` +
        `Something wrote InventoryPosition without postMovement, or a fixture created ` +
        `stock directly (use __tests__/helpers/stock.ts). First: ${JSON.stringify(drift.slice(0, 3))}`,
    );
  }
});
