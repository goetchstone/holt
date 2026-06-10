// /app/src/pages/api/admin/settings/index.ts
//
// Read and update per-organization branding, locale, theme, and feature flags.
// Self-hosted deployments operate on the single default org. Secrets are NOT
// handled here -- see ./integrations.ts for encrypted credentials.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import type { Prisma } from "@prisma/client";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import {
  DEFAULT_ORG_ID,
  DEFAULT_THEME,
  getAppSettings,
  invalidateAppSettingsCache,
  isHexColor,
  type ThemeKey,
} from "@/lib/appSettings";
import { isValidFeatureKey } from "@/lib/featureCatalog";
import { parseBookingConfig } from "@/lib/booking/config";

const THEME_KEYS = Object.keys(DEFAULT_THEME) as ThemeKey[];

export default requireAuthWithRole(["ADMIN"], async (req, res, session) => {
  if (req.method === "GET") return handleGet(res);
  if (req.method === "PUT") return handlePut(req, res, session);
  res.setHeader("Allow", "GET, PUT");
  return res.status(405).json({ error: "Method not allowed" });
});

async function handleGet(res: NextApiResponse) {
  const settings = await getAppSettings();
  return res.json({ settings });
}

function isSafeUrl(value: string): boolean {
  return /^(https?:\/\/|\/)/.test(value.trim());
}

// Returns trimmed string, null (when cleared), or undefined (field not sent).
function optionalText(
  value: unknown,
  field: string,
): { ok: true; value: string | null | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: `${field} must be a string` };
  const trimmed = value.trim();
  return { ok: true, value: trimmed === "" ? null : trimmed };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type SettingsData = Prisma.AppSettingsUncheckedUpdateInput;
type Body = Record<string, unknown>;
// null = ok; an object = the 400 to return.
type ParseError = { error: string } | null;

function parseAppName(body: Body, data: SettingsData): ParseError {
  if (body.appName === undefined) return null;
  if (typeof body.appName !== "string" || body.appName.trim() === "") {
    return { error: "appName must be a non-empty string" };
  }
  data.appName = body.appName.trim();
  return null;
}

function parseTextFields(body: Body, data: SettingsData): ParseError {
  for (const field of ["companyName", "tagline", "supportEmail"] as const) {
    const parsed = optionalText(body[field], field);
    if (!parsed.ok) return { error: parsed.error };
    if (parsed.value !== undefined) data[field] = parsed.value;
  }
  if (
    typeof data.supportEmail === "string" &&
    data.supportEmail &&
    !EMAIL_RE.test(data.supportEmail)
  ) {
    return { error: "supportEmail is not a valid email address" };
  }
  return null;
}

function parseUrlFields(body: Body, data: SettingsData): ParseError {
  for (const field of ["logoUrl", "loginLogoUrl", "faviconUrl"] as const) {
    const parsed = optionalText(body[field], field);
    if (!parsed.ok) return { error: parsed.error };
    if (parsed.value === undefined) continue;
    if (parsed.value !== null && !isSafeUrl(parsed.value)) {
      return { error: `${field} must be an http(s) or root-relative URL` };
    }
    data[field] = parsed.value;
  }
  return null;
}

function parseLocaleFields(body: Body, data: SettingsData): ParseError {
  for (const field of ["currency", "locale", "timezone"] as const) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== "string" || (body[field] as string).trim() === "") {
      return { error: `${field} must be a non-empty string` };
    }
    data[field] = (body[field] as string).trim();
  }
  return null;
}

function parseTheme(body: Body, data: SettingsData): ParseError {
  if (body.theme === undefined) return null;
  if (typeof body.theme !== "object" || body.theme === null) {
    return { error: "theme must be an object" };
  }
  const incoming = body.theme as Record<string, unknown>;
  const theme: Record<string, string> = {};
  for (const key of THEME_KEYS) {
    const value = incoming[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !isHexColor(value)) {
      return { error: `theme.${key} must be a hex color` };
    }
    theme[key] = value.trim();
  }
  // `mode` rides inside the theme JSON (light | dark site chrome). It must be
  // carried through here explicitly -- this function rebuilds the object from
  // a whitelist, so an unhandled key would be silently dropped on every save.
  if (incoming.mode !== undefined) {
    if (incoming.mode !== "light" && incoming.mode !== "dark") {
      return { error: 'theme.mode must be "light" or "dark"' };
    }
    theme.mode = incoming.mode;
  }
  data.theme = theme;
  return null;
}

function parseFeatures(body: Body, data: SettingsData): ParseError {
  if (body.features === undefined) return null;
  if (typeof body.features !== "object" || body.features === null) {
    return { error: "features must be an object" };
  }
  const incoming = body.features as Record<string, unknown>;
  const features: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (!isValidFeatureKey(key)) {
      return { error: `Unknown feature: ${key}` };
    }
    features[key] = Boolean(value);
  }
  data.features = features;
  return null;
}

// Booking config is normalized + clamped by the shared lib parser (lenient,
// never throws), so we store the sanitized result rather than the raw input.
function parseBooking(body: Body, data: SettingsData): ParseError {
  if (body.bookingConfig === undefined) return null;
  if (typeof body.bookingConfig !== "object" || body.bookingConfig === null) {
    return { error: "bookingConfig must be an object" };
  }
  // Spread into a plain numeric record so it satisfies the Prisma JSON input
  // type (a fixed-key interface does not assign to InputJsonValue directly).
  const cfg = parseBookingConfig(body.bookingConfig);
  data.bookingConfig = {
    windowDays: cfg.windowDays,
    startHour: cfg.startHour,
    endHour: cfg.endHour,
    slotMinutes: cfg.slotMinutes,
  };
  return null;
}

const SETTINGS_PARSERS = [
  parseAppName,
  parseTextFields,
  parseUrlFields,
  parseLocaleFields,
  parseTheme,
  parseFeatures,
  parseBooking,
];

async function handlePut(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const body = (req.body ?? {}) as Body;
  const data: SettingsData = {};

  for (const parse of SETTINGS_PARSERS) {
    const result = parse(body, data);
    if (result) return res.status(400).json({ error: result.error });
  }

  const actor = session.user?.email ?? null;

  try {
    await prisma.appSettings.upsert({
      where: { organizationId: DEFAULT_ORG_ID },
      create: {
        ...(data as Prisma.AppSettingsUncheckedCreateInput),
        organizationId: DEFAULT_ORG_ID,
        createdBy: actor,
        updatedBy: actor,
      },
      update: { ...data, updatedBy: actor },
    });
  } catch (err) {
    logError("Failed to update app settings", err);
    return res.status(500).json({ error: "Failed to save settings" });
  }

  invalidateAppSettingsCache(DEFAULT_ORG_ID);
  const settings = await getAppSettings();
  return res.json({ settings });
}
