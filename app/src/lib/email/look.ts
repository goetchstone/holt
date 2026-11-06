// /app/src/lib/email/look.ts
//
// How a store's emails look (GAP-37): its colour, whether its logo heads them, and what
// they say at the foot. Set at Admin > Setup > Email look and wording. One look for every
// email Holt sends, since they all go through layout() in lib/email/templates.ts. Pure.

export interface EmailLook {
  /** Headings, links, buttons and table rules. #rrggbb, checked before it reaches a style. */
  accent: string;
  /** Absolute, since a mail client has nothing to resolve a path against. */
  logoUrl: string | null;
  /** What the foot says. Null is "Sent by {store}." */
  footer: string | null;
}

export const DEFAULT_EMAIL_ACCENT = "#1c1f2e";

export const DEFAULT_EMAIL_LOOK: EmailLook = {
  accent: DEFAULT_EMAIL_ACCENT,
  logoUrl: null,
  footer: null,
};

export const EMAIL_FOOTER_MAX = 1000;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function isEmailColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

/** Dark text on a light colour and light text on a dark one, so a button stays readable. */
export function textOn(accent: string): string {
  const channel = (start: number) => Number.parseInt(accent.slice(start, start + 2), 16);
  const brightness = (channel(1) * 299 + channel(3) * 587 + channel(5) * 114) / 1000;
  return brightness > 150 ? "#14161f" : "#f5f4f0";
}

/** An address a mail client can load, or null. Only http(s) and a path on this server. */
export function absoluteLogoUrl(logoUrl: string | null, baseUrl: string): string | null {
  const url = logoUrl?.trim();
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/") && !url.startsWith("//")) return `${baseUrl.replace(/\/+$/, "")}${url}`;
  return null;
}

export function readEmailLook(
  app: {
    emailAccentColor: string | null;
    emailShowLogo: boolean;
    emailFooter: string | null;
    logoUrl: string | null;
  },
  baseUrl: string,
): EmailLook {
  return {
    accent: isEmailColor(app.emailAccentColor) ? app.emailAccentColor : DEFAULT_EMAIL_ACCENT,
    logoUrl: app.emailShowLogo ? absoluteLogoUrl(app.logoUrl, baseUrl) : null,
    footer: app.emailFooter?.trim() || null,
  };
}
