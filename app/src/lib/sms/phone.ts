// /app/src/lib/sms/phone.ts
//
// A customer's phone as the one form a text provider takes: E.164, "+15551234567".
// Customer.phone is free text ("(555) 123-4567", "555.123.4567 x12"). Pure.
//
// A number with no country code is only read as North American where the
// store's locale says so (rule 63: no default region invented for a store
// elsewhere; a number typed with "+" works anywhere). Anything with letters in
// it, such as an extension, is refused rather than guessed: an extension is a
// desk phone, and it can't take a text.

const E164 = /^\+[1-9]\d{7,14}$/;
const NORTH_AMERICA = new Set(["US", "CA"]);

export function isE164(value: unknown): value is string {
  return typeof value === "string" && E164.test(value);
}

function regionOf(locale: string): string | null {
  try {
    return new Intl.Locale(locale).region ?? null;
  } catch {
    return null;
  }
}

export function toE164(raw: string | null | undefined, locale: string): string | null {
  const text = raw?.trim();
  if (!text || /[a-z#]/i.test(text)) return null;
  const digits = text.replace(/\D/g, "");
  if (text.startsWith("+")) {
    const full = `+${digits}`;
    return isE164(full) ? full : null;
  }
  if (!NORTH_AMERICA.has(regionOf(locale) ?? "")) return null;
  if (/^[2-9]\d{9}$/.test(digits)) return `+1${digits}`;
  if (/^1[2-9]\d{9}$/.test(digits)) return `+${digits}`;
  return null;
}
