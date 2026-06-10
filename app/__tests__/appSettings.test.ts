// /app/__tests__/appSettings.test.ts
import {
  resolveAppSettings,
  themeToCssVars,
  DEFAULT_THEME,
  DEFAULT_APP_SETTINGS,
  type Theme,
} from "@/lib/appSettings";
import { BOOKING_DEFAULTS } from "@/lib/booking/config";

function row(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 1,
    appName: "Acme Retail",
    companyName: "Acme Inc",
    tagline: null,
    logoUrl: null,
    loginLogoUrl: null,
    faviconUrl: null,
    supportEmail: null,
    theme: null,
    currency: "USD",
    locale: "en-US",
    timezone: "America/New_York",
    features: null,
    bookingConfig: null,
    ...overrides,
  };
}

describe("resolveAppSettings", () => {
  it("returns hard defaults for a null row", () => {
    const r = resolveAppSettings(null);
    expect(r.appName).toBe(DEFAULT_APP_SETTINGS.appName);
    expect(r.theme).toEqual(DEFAULT_THEME);
    expect(r.features).toEqual({});
    expect(r.currency).toBe("USD");
    expect(r.bookingConfig).toEqual(BOOKING_DEFAULTS);
    expect(r.themeMode).toBe("light");
  });

  it("resolves themeMode from theme.mode, defaulting light on anything else", () => {
    expect(resolveAppSettings(row({ theme: { mode: "dark" } })).themeMode).toBe("dark");
    expect(resolveAppSettings(row({ theme: { mode: "light" } })).themeMode).toBe("light");
    // unknown / missing / non-string never produce dark
    expect(resolveAppSettings(row({ theme: { mode: "neon" } })).themeMode).toBe("light");
    expect(resolveAppSettings(row({ theme: {} })).themeMode).toBe("light");
    expect(resolveAppSettings(row({ theme: null })).themeMode).toBe("light");
  });

  it("resolves bookingConfig from the row, falling back to defaults", () => {
    expect(resolveAppSettings(row({ bookingConfig: null })).bookingConfig).toEqual(
      BOOKING_DEFAULTS,
    );
    // partial config keeps its provided value and defaults the rest
    const partial = resolveAppSettings(row({ bookingConfig: { windowDays: 30 } })).bookingConfig;
    expect(partial.windowDays).toBe(30);
    expect(partial.slotMinutes).toBe(BOOKING_DEFAULTS.slotMinutes);
    // out-of-range is clamped by the shared parser
    expect(
      resolveAppSettings(row({ bookingConfig: { windowDays: 1000 } })).bookingConfig.windowDays,
    ).toBe(90);
  });

  it("merges a partial theme override over defaults", () => {
    const r = resolveAppSettings(row({ theme: { navy: "#111111", gold: "#ffcc00" } }));
    expect(r.theme.navy).toBe("#111111");
    expect(r.theme.gold).toBe("#ffcc00");
    // untouched keys keep defaults
    expect(r.theme.linen).toBe(DEFAULT_THEME.linen);
  });

  it("ignores non-string theme values", () => {
    const r = resolveAppSettings(row({ theme: { navy: 123, gold: null, linen: "#abcabc" } }));
    expect(r.theme.navy).toBe(DEFAULT_THEME.navy);
    expect(r.theme.gold).toBe(DEFAULT_THEME.gold);
    expect(r.theme.linen).toBe("#abcabc");
  });

  it("coerces feature flags to booleans", () => {
    const r = resolveAppSettings(row({ features: { warehousing: true, dispatch: 0, pos: "yes" } }));
    expect(r.features).toEqual({ warehousing: true, dispatch: false, pos: true });
  });

  it("falls back to defaults when string fields are blank", () => {
    const r = resolveAppSettings(row({ appName: "  ", currency: "", locale: null, timezone: " " }));
    expect(r.appName).toBe(DEFAULT_APP_SETTINGS.appName);
    expect(r.currency).toBe("USD");
    expect(r.locale).toBe("en-US");
    expect(r.timezone).toBe("America/New_York");
  });
});

describe("themeToCssVars", () => {
  it("emits RGB channel custom properties for every key", () => {
    const css = themeToCssVars(DEFAULT_THEME);
    expect(css.startsWith(":root{")).toBe(true);
    expect(css).toContain("--brand-navy:0 38 62");
    expect(css).toContain("--brand-linen:247 245 241");
    expect(css).toContain("--brand-accent-blue:105 130 158");
  });

  it("expands 3-digit hex", () => {
    const css = themeToCssVars({ ...DEFAULT_THEME, navy: "#abc" });
    expect(css).toContain("--brand-navy:170 187 204");
  });

  it("skips invalid values so it cannot break out of a <style> block", () => {
    const css = themeToCssVars({ ...DEFAULT_THEME, navy: "</style><script>", gold: "red" });
    expect(css).not.toContain("script");
    expect(css).not.toContain("red");
    // valid siblings still emitted
    expect(css).toContain("--brand-linen:247 245 241");
  });

  it("returns an empty string when no value is valid", () => {
    const allBad: Theme = { ...DEFAULT_THEME };
    for (const key of Object.keys(allBad) as (keyof Theme)[]) allBad[key] = "nope";
    expect(themeToCssVars(allBad)).toBe("");
  });
});
