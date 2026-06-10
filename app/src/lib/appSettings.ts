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
import type { Branding } from "@/lib/branding";
import { parseBookingConfig, BOOKING_DEFAULTS, type BookingConfig } from "@/lib/booking/config";

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
}

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
    timezone: row.timezone?.trim() || DEFAULT_APP_SETTINGS.timezone,
    features,
    bookingConfig: parseBookingConfig(row.bookingConfig),
  };
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
// so opacity modifiers (bg-sh-blue/50) keep working.
export function themeToCssVars(theme: Theme): string {
  const declarations: string[] = [];
  for (const key of Object.keys(THEME_CSS_VARS) as ThemeKey[]) {
    const channels = hexToRgbChannels(theme[key] ?? "");
    if (!channels) continue;
    for (const cssVar of THEME_CSS_VARS[key]) declarations.push(`${cssVar}:${channels}`);
  }
  return declarations.length ? `:root{${declarations.join(";")}}` : "";
}
