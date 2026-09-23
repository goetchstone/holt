// /app/src/lib/numberingPrefix.ts
//
// The prefixes a business stamps on its own sales-order numbers
// (`<prefix>-YYMMDD-NNN`) and generated barcodes (`<prefix>-<vendor>-<product>-XXXX`).
// Both were one pilot's initials, hardcoded, before USE-12.
//
// Pure -- no Prisma -- so the settings form can show the default as the name is
// typed, from the same rule the server applies (principle 6: one home).

/** A prefix is 1-6 letters or digits; the separating dash is added, never stored. */
export const PREFIX_PATTERN = /^[A-Z0-9]{1,6}$/;

/**
 * The default when none is set: the initials of the business's own name, at
 * most four. An unset prefix must never block a sale, and must never be some
 * other business's.
 */
export function derivePrefix(name: string): string {
  const initials = name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())
    .join("")
    .slice(0, 4);
  return initials || "ORD";
}

/** A stored or submitted prefix, upper-cased; null when it is not 1-6 letters or digits. */
export function parsePrefix(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const p = raw.trim().toUpperCase();
  return PREFIX_PATTERN.test(p) ? p : null;
}

interface NumberingSettings {
  appName: string;
  companyName: string | null;
  orderNumberPrefix: string | null;
  barcodePrefix: string | null;
}

/** The prefix in force: the one set in Settings, else the business's initials. */
export function effectivePrefix(
  settings: NumberingSettings,
  which: "orderNumberPrefix" | "barcodePrefix",
): string {
  return settings[which] ?? derivePrefix(settings.companyName?.trim() || settings.appName);
}
