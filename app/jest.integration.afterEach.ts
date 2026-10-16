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
