// /app/src/lib/formatMoney.ts
//
// Client-safe locale/currency/date formatting. No Prisma, no server imports --
// safe to bundle into the browser (money.ts imports Prisma and is server-only,
// so display formatting lives here instead). All helpers take an explicit
// locale/currency so the same value renders correctly for any tenant; the
// useLocale() hook supplies the org's configured values from settings.

export interface LocaleConfig {
  locale: string;
  currency: string;
  timezone: string;
}

export const DEFAULT_LOCALE_CONFIG: LocaleConfig = {
  locale: "en-US",
  currency: "USD",
  timezone: "America/New_York",
};

interface MoneyOptions {
  locale?: string;
  currency?: string;
  /** Drop the cents (whole-dollar display). Default false. */
  whole?: boolean;
}

/**
 * Format a number as a currency string for the given locale + currency.
 * Falls back to the default locale/currency when not supplied. Coerces
 * null/undefined/NaN to 0 so a missing value renders "$0.00", never a bare
 * symbol or "NaN".
 */
export function formatMoney(value: number | null | undefined, opts: MoneyOptions = {}): string {
  const amount = typeof value === "number" && Number.isFinite(value) ? value : 0;
  const locale = opts.locale || DEFAULT_LOCALE_CONFIG.locale;
  const currency = opts.currency || DEFAULT_LOCALE_CONFIG.currency;
  const fractionDigits = opts.whole ? 0 : 2;
  try {
    return amount.toLocaleString(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
  } catch {
    // Invalid locale/currency code -> fall back to the default config so a
    // misconfigured setting degrades gracefully instead of throwing.
    return amount.toLocaleString(DEFAULT_LOCALE_CONFIG.locale, {
      style: "currency",
      currency: DEFAULT_LOCALE_CONFIG.currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
  }
}

interface DateOptions {
  locale?: string;
  timezone?: string;
  /** Intl date style. Default "medium" (e.g. "May 30, 2026"). */
  dateStyle?: "full" | "long" | "medium" | "short";
}

/**
 * Format a Date (or ISO string / epoch ms) for the given locale + timezone.
 * Returns "" for null/undefined/invalid input so callers can render a blank
 * cell rather than "Invalid Date".
 */
export function formatDate(
  value: Date | string | number | null | undefined,
  opts: DateOptions = {},
): string {
  if (value === null || value === undefined || value === "") return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const locale = opts.locale || DEFAULT_LOCALE_CONFIG.locale;
  const timezone = opts.timezone || DEFAULT_LOCALE_CONFIG.timezone;
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: opts.dateStyle ?? "medium",
      timeZone: timezone,
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat(DEFAULT_LOCALE_CONFIG.locale, {
      dateStyle: opts.dateStyle ?? "medium",
    }).format(d);
  }
}

/**
 * Format a Date with both date and time for the given locale + timezone.
 * Same null-safety as formatDate.
 */
export function formatDateTime(
  value: Date | string | number | null | undefined,
  opts: DateOptions & { timeStyle?: "full" | "long" | "medium" | "short" } = {},
): string {
  if (value === null || value === undefined || value === "") return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const locale = opts.locale || DEFAULT_LOCALE_CONFIG.locale;
  const timezone = opts.timezone || DEFAULT_LOCALE_CONFIG.timezone;
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: opts.dateStyle ?? "medium",
      timeStyle: opts.timeStyle ?? "short",
      timeZone: timezone,
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat(DEFAULT_LOCALE_CONFIG.locale, {
      dateStyle: opts.dateStyle ?? "medium",
      timeStyle: opts.timeStyle ?? "short",
    }).format(d);
  }
}
