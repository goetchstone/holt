// /app/src/lib/imports/runners/customerRunner.ts
//
// Registers the EXISTING customer import path (lib/genericImportRunner.ts)
// under the runnerKey "customer" -- proving the runner-registry seam
// (lib/imports/runnerRegistry.ts) with a real consumer instead of a toy.
// This is an adapter, not a rewrite: behavior is byte-for-byte the same as
// before this file existed. It converts the definition's field mappings
// into the ColumnMapping shape runGenericImport already expects, and
// delegates.
//
// customer/product don't need a runnerKey to satisfy the RECONCILE rule --
// they are UPSERT-mode (delta source, matched by externalId / name+email),
// not RECONCILE. They use one anyway because findOrCreateCustomer's
// cascading dedup (external id, then trusted email+name, then name alone,
// with late-hydration of stub records) predates this model and is cheaper
// to reuse through the escape hatch than to reimplement as pure config
// right now. See docs/domains/imports-configurable.md for why runnerKey is
// available to any importMode, not only RECONCILE.
//
// Value mappings are not applied here: none of the customer entity's
// fields (genericImport.ts) are configured with a bounded target
// vocabulary today, so there is nothing for this adapter to translate. A
// future runner whose fields DO need value-mapping should apply
// lib/imports/engine.ts's value-mapping step explicitly rather than
// skipping it the way this one does.

import { runGenericImport } from "@/lib/genericImportRunner";
import type { GenericImportResult } from "@/lib/genericImport";
import type { ImportRunnerContext } from "@/lib/imports/types";
import { toColumnMapping } from "@/lib/imports/runners/adaptColumnMapping";

export async function runCustomerRunner(ctx: ImportRunnerContext): Promise<GenericImportResult> {
  return runGenericImport("customer", toColumnMapping(ctx.fieldMappings), ctx.rows, ctx.userEmail);
}
