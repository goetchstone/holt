// /app/src/lib/adapters/legacyPos/storedNames.ts
//
// The names this adapter cannot change on its own. Each one lives outside this
// repo (in a deployment's database, its environment, or a file the POS writes),
// so it keeps the POS's own spelling here even though the code around it does
// not. One file, so that spelling is in one place and the reason is beside it.

/**
 * The adapter's id, as stored in AppSettings.sourceAdapterId (which selects it)
 * and AdapterOrderFlag.adapter (which keys operators' per-order overrides).
 *
 * Changing the value needs a data migration. Without one, getSourceAdapter()
 * throws on the stored id and the nightly import stops, and every override an
 * operator has set silently stops being found.
 */
export const LEGACY_POS_ADAPTER_ID = "ordorite";

/** The id column's header in the POS's item export: a name in someone else's file. */
export const POS_ITEM_ID_COLUMN = "OrdoriteID";

/** What each setting was called before these settings had neutral names. */
const EARLIER_ENV_NAMES = {
  LEGACY_POS_REPORT_PREFIX: "ORDORITE_REPORT_PREFIX",
  LEGACY_POS_STORE_CODES: "ORDORITE_STORE_CODES",
  LEGACY_POS_RETURN_PREFIXES: "ORDORITE_RETURN_PREFIXES",
} as const;

/**
 * A deployment's setting, under its name or the name it had before. A deployment
 * that set the earlier name must keep importing, and these fail closed when
 * unset: report filenames stop routing and returns stop being recognised, with
 * no error to say why. An explicitly empty value counts as set.
 */
export function legacyPosEnv(name: keyof typeof EARLIER_ENV_NAMES): string | undefined {
  return process.env[name] ?? process.env[EARLIER_ENV_NAMES[name]];
}
