// /app/src/lib/imports/runnerRegistry.ts
//
// The code-backed escape hatch (Stage 1 item 4). A registered runner owns
// row processing for an ImportDefinition -- required when importMode =
// RECONCILE (validation.ts + the DB CHECK constraint enforce this), optional
// otherwise -- but still receives the definition's field and value
// mappings, so an operator-configured mapping keeps applying even when the
// write-side logic is too specific for the generic engine.
//
// Compile-time switch over a flat catalog, the same pattern as
// lib/payments/index.ts -- NOT dynamic loading. Adding a runner means
// adding an import and a map entry here, not registering a file path or a
// string that resolves at runtime.

import type { ImportRunner } from "@/lib/imports/types";
import { runCustomerRunner } from "@/lib/imports/runners/customerRunner";
import { runProductRunner } from "@/lib/imports/runners/productRunner";

const RUNNERS: Record<string, ImportRunner> = {
  customer: runCustomerRunner,
  product: runProductRunner,
};

export function isRegisteredRunnerKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(RUNNERS, key);
}

export function listRegisteredRunnerKeys(): string[] {
  return Object.keys(RUNNERS);
}

/**
 * Resolve a runnerKey to its implementation. Throws (rather than returning
 * undefined) for the same reason lib/payments/index.ts's getPaymentProvider
 * does -- every caller needs a runner to continue, and an operator-readable
 * message beats a null-deref three frames later.
 */
export function getImportRunner(key: string): ImportRunner {
  const runner = RUNNERS[key];
  if (!runner) {
    const known = listRegisteredRunnerKeys().join(", ") || "(none)";
    throw new Error(`Import runner "${key}" is not registered. Registered runners: ${known}.`);
  }
  return runner;
}
