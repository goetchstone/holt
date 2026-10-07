// /app/src/lib/appSettings.ts
//
// Per-organization settings accessor. Reads the AppSettings row (branding,
// locale, feature flags, theme) and merges it over hard defaults so callers
// always get a complete object even before an org has customized anything.
// Self-hosted deployments run a single org (DEFAULT_ORG_ID); the multi-tenant
// build passes the resolved org id.
//
// The theme bridge (themeToCssVars) turns the stored hex palette into the
// RGB-channel CSS custom properties that the Tailwind @theme block in
// globals.css consumes, so the whole UI re-skins from settings without
// touching component code.

import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { isValidTimeZone } from "@/lib/reports/businessDay";
import type { Branding } from "@/lib/branding";
import { parseBookingConfig, BOOKING_DEFAULTS, type BookingConfig } from "@/lib/booking/config";
import { parsePrefix } from "@/lib/numberingPrefix";

export const DEFAULT_ORG_ID = 1;

// Default brand palette (hex). Keys mirror AppSettings.theme JSON.
export const DEFAULT_THEME = {
  navy: "#00263E",
  linen: "#F7F5F1",
  gold: "#A78A5A",
  gray: "#6D6D6D",
  black: "#0D0D0D",
  stripe: "#F5F5F5",
  brandGray: "#b2b4bb",
  brandBlue: "#69829E",
} as const;

export type ThemeKey = keyof typeof DEFAULT_THEME;
export type Theme = Record<ThemeKey, string>;

// Site chrome mode. Stored inside the AppSettings.theme JSON as `mode` (no
// migration needed); "dark" renders the public-site header/footer/body on the
// navy/stripe tokens instead of white/linen. The back-office is unaffected.
export type ThemeMode = "light" | "dark";

// Theme key -> the CSS custom properties it drives. navy feeds both the
// primary and the navy alias token.
const THEME_CSS_VARS: Record<ThemeKey, string[]> = {
  navy: ["--brand-navy"],
  linen: ["--brand-linen"],
  gold: ["--brand-gold"],
  gray: ["--brand-gray"],
  black: ["--brand-black"],
  stripe: ["--brand-stripe"],
  brandGray: ["--brand-accent-gray"],
  brandBlue: ["--brand-accent-blue"],
};

export interface ResolvedAppSettings {
  organizationId: number;
  appName: string;
  companyName: string | null;
  tagline: string | null;
  logoUrl: string | null;
  loginLogoUrl: string | null;
  faviconUrl: string | null;
  supportEmail: string | null;
  theme: Theme;
  themeMode: ThemeMode;
  currency: string;
  locale: string;
  timezone: string;
  features: Record<string, boolean>;
  bookingConfig: BookingConfig;
  /** Which SourceAdapter pulls data from a prior system. "none" = nothing does. */
  sourceAdapterId: string;
  /** Store-wide retail markup fallback. null = unset; the catalog then shows
   * cost and refuses to invent a retail price when a vendor also lacks one. */
  pricing: { defaultMarkup: number | null };
  /** Google Drive/Slides project-creation config. A null folder or template =>
   * the Create Project route refuses (503) rather than writing into the wrong
   * Drive; the subfolder list defaults to the standard set. */
  google: {
    drive: { projectsRootFolderId: string | null; projectSubfolders: string[] };
    slides: { templatePresentationId: string | null };
  };
  /** Order-portal link lifetime in hours, 1-PORTAL_TOKEN_TTL_MAX_HOURS. null =
   * unset; generatePortalToken then applies its 48-hour default. */
  portalTokenTtlHours: number | null;
  /** The prefix set for sales-order numbers, or null (unset). Read it through
   * numberingPrefix.effectivePrefix, which supplies the default. */
  orderNumberPrefix: string | null;
  /** The prefix set for generated barcodes, or null. As above. */
  barcodePrefix: string | null;
}

/** Upper bound on an order-portal link's lifetime: those links are not
 * revocable, so the setting may shorten the window but never stretch it past
 * the 7 days it was fixed at before SEC-08. */
export const PORTAL_TOKEN_TTL_MAX_HOURS = 168;

// The subfolders created in each project folder when the deployment has not
// configured its own list. Order is the display/creation order.
const DEFAULT_GOOGLE_SUBFOLDERS = [
  "Windows",
  "Rugs",
  "Fabrics",
  "Furniture",
  "Photos",
  "Presentation",
];

export const DEFAULT_APP_SETTINGS: ResolvedAppSettings = {
  organizationId: DEFAULT_ORG_ID,
  appName: "Holt",
  companyName: null,
  tagline: null,
  logoUrl: null,
  loginLogoUrl: null,
  faviconUrl: null,
  supportEmail: null,
  theme: { ...DEFAULT_THEME },
  themeMode: "light",
  currency: "USD",
  locale: "en-US",
  timezone: "America/New_York",
  features: {},
  bookingConfig: { ...BOOKING_DEFAULTS },
  sourceAdapterId: "none",
  pricing: { defaultMarkup: null },
  google: {
    drive: { projectsRootFolderId: null, projectSubfolders: [...DEFAULT_GOOGLE_SUBFOLDERS] },
    slides: { templatePresentationId: null },
  },
  portalTokenTtlHours: null,
  orderNumberPrefix: null,
  barcodePrefix: null,
};

// Loosely typed view of the DB row -- the Json columns arrive as unknown.
interface AppSettingsRow {
  organizationId: number;
  appName: string | null;
  companyName: string | null;
  tagline: string | null;
  logoUrl: string | null;
  loginLogoUrl: string | null;
  faviconUrl: string | null;
  supportEmail: string | null;
  theme: unknown;
  currency: string | null;
  locale: string | null;
  timezone: string | null;
  features: unknown;
  bookingConfig: unknown;
  // Loose: absent (partial select / pre-column row) resolves to no fallback.
  pricing?: unknown;
  google?: unknown;
  portalTokenTtlHours?: number | null;
  orderNumberPrefix?: string | null;
  barcodePrefix?: string | null;
  // Optional because this is a LOOSE view of the row: a partial select, or a
  // row read before the column existed, simply doesn't carry it. Absent
  // resolves to the default exactly as an empty string does.
  sourceAdapterId?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Pure: merge a DB row (or null) over the hard defaults. Exported for unit
// tests so the resolution logic is verified without a database.
export function resolveAppSettings(row: AppSettingsRow | null): ResolvedAppSettings {
  if (!row) {
    return {
      ...DEFAULT_APP_SETTINGS,
      theme: { ...DEFAULT_THEME },
      features: {},
      bookingConfig: { ...BOOKING_DEFAULTS },
      pricing: { defaultMarkup: null },
      google: {
        drive: { projectsRootFolderId: null, projectSubfolders: [...DEFAULT_GOOGLE_SUBFOLDERS] },
        slides: { templatePresentationId: null },
      },
    };
  }

  const theme = { ...DEFAULT_THEME } as Theme;
  let themeMode: ThemeMode = "light";
  if (isRecord(row.theme)) {
    for (const key of Object.keys(DEFAULT_THEME) as ThemeKey[]) {
      const value = row.theme[key];
      if (typeof value === "string" && value.trim()) theme[key] = value.trim();
    }
    if (row.theme.mode === "dark") themeMode = "dark";
  }

  const features: Record<string, boolean> = {};
  if (isRecord(row.features)) {
    for (const [key, value] of Object.entries(row.features)) features[key] = Boolean(value);
  }

  return {
    organizationId: row.organizationId,
    appName: row.appName?.trim() || DEFAULT_APP_SETTINGS.appName,
    companyName: row.companyName ?? null,
    tagline: row.tagline ?? null,
    logoUrl: row.logoUrl ?? null,
    loginLogoUrl: row.loginLogoUrl ?? null,
    faviconUrl: row.faviconUrl ?? null,
    supportEmail: row.supportEmail ?? null,
    theme,
    themeMode,
    currency: row.currency?.trim() || DEFAULT_APP_SETTINGS.currency,
    locale: row.locale?.trim() || DEFAULT_APP_SETTINGS.locale,
    timezone: safeTimeZone(row.timezone),
    features,
    bookingConfig: parseBookingConfig(row.bookingConfig),
    // An unknown id resolves in the registry, not here -- this layer reports
    // what the database says, so a typo surfaces as "adapter X is not in this
    // build" rather than silently reverting to "none".
    sourceAdapterId: row.sourceAdapterId?.trim() || DEFAULT_APP_SETTINGS.sourceAdapterId,
    pricing: parsePricingConfig(row.pricing),
    google: parseGoogleConfig(row.google),
    portalTokenTtlHours: parsePortalTokenTtlHours(row.portalTokenTtlHours),
    // A stored prefix that is not 1-6 letters or digits resolves to unset.
    orderNumberPrefix: parsePrefix(row.orderNumberPrefix),
    barcodePrefix: parsePrefix(row.barcodePrefix),
  };
}

// A store-wide markup fallback is honoured only when it is an explicit, positive,
// finite number. Anything else -- absent, null, zero, a string -- resolves to
// "unset" so the catalog fails closed rather than inventing a retail price.
function parsePricingConfig(raw: unknown): { defaultMarkup: number | null } {
  if (isRecord(raw)) {
    const m = raw.defaultMarkup;
    if (typeof m === "number" && Number.isFinite(m) && m > 0) return { defaultMarkup: m };
  }
  return { defaultMarkup: null };
}

// Google project-creation config, fail-closed like pricing: the folder and
// template ids resolve to null unless an explicit non-empty string is stored,
// so an unconfigured deployment is refused rather than pointed at the wrong
// Drive. The subfolder list falls back to the standard set when absent or empty.
function parseGoogleConfig(raw: unknown): ResolvedAppSettings["google"] {
  const drive: Record<string, unknown> = isRecord(raw) && isRecord(raw.drive) ? raw.drive : {};
  const slides: Record<string, unknown> = isRecord(raw) && isRecord(raw.slides) ? raw.slides : {};
  return {
    drive: {
      projectsRootFolderId: nonEmptyString(drive.projectsRootFolderId),
      projectSubfolders: subfolderList(drive.projectSubfolders),
    },
    slides: { templatePresentationId: nonEmptyString(slides.templatePresentationId) },
  };
}

/** A trimmed, non-empty string, or null. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The trimmed, non-empty names; a fresh copy of the standard set when none remain. */
function subfolderList(value: unknown): string[] {
  const names = Array.isArray(value)
    ? value
        .filter((s): s is string => typeof s === "string" && s.trim() !== "")
        .map((s) => s.trim())
    : [];
  return names.length > 0 ? names : [...DEFAULT_GOOGLE_SUBFOLDERS];
}

// Honoured only as a whole number of hours inside 1..PORTAL_TOKEN_TTL_MAX_HOURS.
// Anything else -- absent, zero, fractional, over the cap -- resolves to unset,
// and the link falls back to its 48-hour default rather than a stretched window.
function parsePortalTokenTtlHours(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1) {
    return raw <= PORTAL_TOKEN_TTL_MAX_HOURS ? raw : null;
  }
  return null;
}

const cache = new Map<number, { value: ResolvedAppSettings; expires: number }>();
const CACHE_TTL_MS = 60_000;

export async function getAppSettings(orgId: number = DEFAULT_ORG_ID): Promise<ResolvedAppSettings> {
  const hit = cache.get(orgId);
  if (hit && hit.expires > Date.now()) return hit.value;
  try {
    const row = await prisma.appSettings.findUnique({ where: { organizationId: orgId } });
    const value = resolveAppSettings(row as AppSettingsRow | null);
    cache.set(orgId, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (err) {
    logError("getAppSettings failed; falling back to defaults", err, { orgId });
    return {
      ...DEFAULT_APP_SETTINGS,
      theme: { ...DEFAULT_THEME },
      features: {},
      bookingConfig: { ...BOOKING_DEFAULTS },
    };
  }
}

export function invalidateAppSettingsCache(orgId?: number): void {
  if (orgId === undefined) cache.clear();
  else cache.delete(orgId);
}

// Display-only branding subset, safe to ship to the client (no secrets, no
// feature flags). Resolved server-side and injected into pageProps by
// withAuth so the chrome renders branded on first paint.
export async function getPublicBranding(orgId: number = DEFAULT_ORG_ID): Promise<Branding> {
  const s = await getAppSettings(orgId);
  return {
    appName: s.appName,
    companyName: s.companyName,
    tagline: s.tagline,
    logoUrl: s.logoUrl,
    loginLogoUrl: s.loginLogoUrl,
    faviconUrl: s.faviconUrl,
    currency: s.currency,
    locale: s.locale,
    timezone: s.timezone,
  };
}

const HEX_COLOR = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value.trim());
}

// "#00263E" / "#abc" -> "0 38 62". Returns null for anything that is not a
// 3- or 6-digit hex value -- which also guarantees the output is safe to drop
// inside a <style> block (digits and spaces only, no breakout characters).
function hexToRgbChannels(hex: string): string | null {
  const match = HEX_COLOR.exec(hex.trim());
  if (!match) return null;
  let value = match[1];
  if (value.length === 3) {
    value = value
      .split("")
      .map((char) => char + char)
      .join("");
  }
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

// Build the `:root { --brand-*: r g b; }` declaration block from a theme.
// Tailwind tokens reference these as `rgb(var(--brand-navy) / <alpha-value>)`
// so opacity modifiers (bg-brand-blue/50) keep working.
export function themeToCssVars(theme: Theme): string {
  const declarations: string[] = [];
  for (const key of Object.keys(THEME_CSS_VARS) as ThemeKey[]) {
    const channels = hexToRgbChannels(theme[key] ?? "");
    if (!channels) continue;
    for (const cssVar of THEME_CSS_VARS[key]) declarations.push(`${cssVar}:${channels}`);
  }
  return declarations.length ? `:root{${declarations.join(";")}}` : "";
}

/**
 * The deployment's business timezone -- the one every "what happened on this
 * day" question must resolve against. Cached 60s inside getAppSettings, and it
 * falls back to defaults rather than throwing, so a report never fails because
 * settings were unreadable.
 *
 * Lives here rather than beside the date helpers in lib/reports/businessDay.ts
 * so that those stay pure: they are imported transitively by client components,
 * and a settings read drags Prisma into the browser bundle.
 */
/**
 * A stored timezone the date helpers can actually use.
 *
 * This used to be `row.timezone?.trim() || DEFAULT`, which only guarded EMPTY.
 * A non-empty but invalid value -- the settings form is free text -- passed
 * straight through to Intl.DateTimeFormat and threw a RangeError inside
 * salesDaily, generateSalesJournal and computeDailyReconciliation alike.
 *
 * Falling back is the right failure mode here rather than throwing: this
 * function's whole contract is that reads never fail on unreadable settings.
 * The row is still wrong and an operator has to fix it, so it is logged.
 */
function safeTimeZone(stored: string | null): string {
  const trimmed = stored?.trim();
  if (!trimmed) return DEFAULT_APP_SETTINGS.timezone;
  if (isValidTimeZone(trimmed)) return trimmed;
  logError(
    "AppSettings.timezone is not a timezone this runtime recognises; falling back",
    new Error(`invalid timezone ${JSON.stringify(trimmed)}`),
  );
  return DEFAULT_APP_SETTINGS.timezone;
}

export async function getBusinessTimeZone(): Promise<string> {
  const settings = await getAppSettings();
  return settings.timezone;
}
