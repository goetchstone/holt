// /app/src/lib/adapters/index.ts
//
// Source-adapter registry + resolution.
//
// Same shape as lib/payments/index.ts: a flat catalog and a lookup, not a DI
// container -- nothing else in this codebase uses one, and the set of adapters
// is compile-time known.
//
// ONE difference from payments, and it matters. A payment needs TWO questions
// answered separately ("who should take a new payment" vs "who took THIS one",
// because a refund must go back through the processor that captured it). An
// import has no such history: rows already imported are holt's rows now, and
// nothing routes back to the source. So there is one question here --
// getActiveSourceAdapter() -- and adding a second later would be a smell.

import { noneAdapter } from "@/lib/adapters/noneAdapter";
import { ordoriteAdapter } from "@/lib/adapters/ordorite/adapter";
import type { SourceAdapter } from "@/lib/adapters/types";
import { getAppSettings } from "@/lib/appSettings";
import { isFeatureEnabled } from "@/lib/featureCatalog";

export type { ImportRunSummary, SourceAdapter, SourceAdapterReadiness } from "@/lib/adapters/types";

/**
 * Every adapter this build knows about. Adding a source system is: implement
 * SourceAdapter, add one line here, ship. That is the entire cost, and it is
 * the claim this module exists to make true.
 */
const ADAPTERS: SourceAdapter[] = [noneAdapter, ordoriteAdapter];

const BY_ID = new Map(ADAPTERS.map((a) => [a.id, a]));

/** Catalog for the admin picker. Never includes secrets. */
export function listSourceAdapters(): { id: string; label: string; description: string }[] {
  return ADAPTERS.map((a) => ({ id: a.id, label: a.label, description: a.description }));
}

export function isSourceAdapterId(value: string | null | undefined): boolean {
  return typeof value === "string" && BY_ID.has(value);
}

/**
 * Look up by id. Throws rather than returning undefined -- every caller needs
 * an adapter to continue, and an operator-readable message beats a null-deref
 * three frames later. Same reasoning as getPaymentProvider().
 */
export function getSourceAdapter(id: string): SourceAdapter {
  const adapter = BY_ID.get(id);
  if (!adapter) {
    throw new Error(
      `Source adapter "${id}" is not available in this build. ` +
        `Known adapters: ${ADAPTERS.map((a) => a.id).join(", ")}. ` +
        `Change it in Settings, or check that the deployment is running the build you think it is.`,
    );
  }
  return adapter;
}

/**
 * The adapter this deployment pulls from.
 *
 * A configured adapter whose module flag is OFF resolves to `none`, not to an
 * error: turning a module off is how an operator disables a feature, and it
 * would be perverse for that to start throwing on a nightly cron. The
 * selection is left in AppSettings so re-enabling the module restores it.
 *
 * An id that no longer exists in the build DOES throw. That is a deployment
 * running the wrong image or a botched rename, and silently importing nothing
 * is the worst possible response -- reports go stale and no one is told.
 */
export async function getActiveSourceAdapter(): Promise<SourceAdapter> {
  const settings = await getAppSettings();
  const adapter = getSourceAdapter(settings.sourceAdapterId);
  if (adapter.moduleFlag && !isFeatureEnabled(settings.features, adapter.moduleFlag)) {
    return noneAdapter;
  }
  return adapter;
}
