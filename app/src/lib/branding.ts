// /app/src/lib/branding.ts
//
// Client-safe branding contract. This module is imported by client code
// (the branding context, layouts, login) so it must NOT import prisma or
// anything that pulls it in. The server-side resolver that reads the DB row
// lives in lib/appSettings.ts (getPublicBranding) and returns this shape.

export interface Branding {
  appName: string;
  companyName: string | null;
  tagline: string | null;
  logoUrl: string | null;
  loginLogoUrl: string | null;
  faviconUrl: string | null;
  // Locale/formatting config travels with branding (both are per-tenant display
  // settings resolved from AppSettings). useLocale() reads these; useBranding()
  // exposes the whole object. Kept on one payload to avoid a second provider +
  // pageProps key threading through withAuth.
  currency: string;
  locale: string;
  timezone: string;
}

export const DEFAULT_BRANDING: Branding = {
  appName: "Holt",
  companyName: null,
  tagline: null,
  logoUrl: null,
  loginLogoUrl: null,
  faviconUrl: null,
  currency: "USD",
  locale: "en-US",
  timezone: "America/New_York",
};

// Product / maker mark. The maker attribution is DEPLOYMENT config, not a fixed
// string: it defaults to empty so a white-label install shows NO
// product attribution anywhere. The product's own deployment (Akritos) opts in
// by setting the NEXT_PUBLIC_MAKER_* env vars at build time. Render sites must
// treat an empty `attribution` as "show nothing". (Can graduate to an
// AppSettings field later if runtime-editable attribution is ever wanted.)
export const PRODUCT = {
  name: "Holt",
  maker: process.env.NEXT_PUBLIC_MAKER_NAME ?? "",
  makerUrl: process.env.NEXT_PUBLIC_MAKER_URL ?? "",
  attribution: process.env.NEXT_PUBLIC_MAKER_ATTRIBUTION ?? "",
} as const;
