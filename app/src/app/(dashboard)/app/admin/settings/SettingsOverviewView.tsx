"use client";

// /app/src/app/(dashboard)/app/admin/settings/SettingsOverviewView.tsx
//
// Settings overview: the core, always-present sections (Branding, Theme,
// Localization, Booking) plus the Modules on/off grid, plus an index of
// enabled modules that have their own settings page (lib/modules -- the
// module manifest, docs/domains/modules.md). Integrations moved to its own
// route (./integrations) since it was already the size of a page on its own.
//
// This is the App Router replacement for the old single 595-line
// SettingsView.tsx -- same branding/theme/localization/booking/modules
// behavior, same /api/admin/settings contract, just no longer sharing one
// page with Integrations and now driven by the module manifest instead of a
// hand-maintained FEATURES list.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "react-toastify";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";
import { MODULES, getToggleableModules, getModulesForSettingsIndex } from "@/lib/modules";
import { isFeatureEnabled } from "@/lib/featureCatalog";
import { ImageUploadField } from "@/components/cms/admin/ImageUploadField";
import type { ResolvedAppSettings } from "@/lib/appSettings";

// fetch() bodies are plain objects, not axios errors, so getErrorMessage can't
// reach the server's { error } -- pull it out here, then let the outer catch
// surface the thrown Error via getErrorMessage.
function serverError(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const msg = (data as { error?: unknown }).error;
    if (typeof msg === "string" && msg.trim()) return msg;
  }
  return fallback;
}

const THEME_FIELDS: { key: string; label: string }[] = [
  { key: "navy", label: "Primary (Navy)" },
  { key: "linen", label: "Background (Linen)" },
  { key: "gold", label: "Accent (Gold)" },
  { key: "gray", label: "Body text (Gray)" },
  { key: "black", label: "Near black" },
  { key: "stripe", label: "Table stripe" },
  { key: "brandGray", label: "Brand gray" },
  { key: "brandBlue", label: "Brand blue" },
];

type StringSettingKey =
  | "appName"
  | "companyName"
  | "tagline"
  | "supportEmail"
  | "logoUrl"
  | "loginLogoUrl"
  | "faviconUrl"
  | "currency"
  | "locale"
  | "timezone";

const TEXT_FIELDS: {
  key: StringSettingKey;
  label: string;
  placeholder?: string;
  image?: boolean;
}[] = [
  { key: "appName", label: "Application name", placeholder: "Holt" },
  { key: "companyName", label: "Company name", placeholder: "Your company" },
  { key: "tagline", label: "Tagline" },
  { key: "supportEmail", label: "Support email", placeholder: "support@example.com" },
  { key: "logoUrl", label: "Logo URL", placeholder: "https://… or /logo.png", image: true },
  { key: "loginLogoUrl", label: "Login logo URL", image: true },
  { key: "faviconUrl", label: "Favicon URL", image: true },
];

function BrandingSection({
  settings,
  onChange,
}: Readonly<{
  settings: ResolvedAppSettings;
  onChange: (key: StringSettingKey, value: string) => void;
}>) {
  return (
    <section className="space-y-4">
      <h2 className="font-serif text-lg text-sh-blue">Branding</h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {TEXT_FIELDS.map((f) =>
          f.image ? (
            <div key={f.key}>
              <ImageUploadField
                label={f.label}
                value={(settings[f.key] as string | null) ?? ""}
                onChange={(v) => onChange(f.key, v)}
                placeholder={f.placeholder}
              />
            </div>
          ) : (
            <div key={f.key}>
              <label htmlFor={`field-${f.key}`} className="mb-1 block text-sm text-sh-gray">
                {f.label}
              </label>
              <input
                id={`field-${f.key}`}
                type="text"
                value={(settings[f.key] as string | null) ?? ""}
                placeholder={f.placeholder}
                onChange={(e) => onChange(f.key, e.target.value)}
                className="w-full rounded-md border border-sh-brand-gray px-3 py-2 text-sh-black focus:border-sh-blue focus:outline-none"
              />
            </div>
          ),
        )}
      </div>
    </section>
  );
}

function ThemeSection({
  settings,
  onChange,
  onModeChange,
}: Readonly<{
  settings: ResolvedAppSettings;
  onChange: (key: string, value: string) => void;
  onModeChange: (mode: "light" | "dark") => void;
}>) {
  return (
    <section className="space-y-4">
      <h2 className="font-serif text-lg text-sh-blue">Theme colors</h2>
      <div className="max-w-xs">
        <label htmlFor="theme-mode" className="mb-1 block text-sm text-sh-gray">
          Public site chrome
        </label>
        <select
          id="theme-mode"
          value={settings.themeMode}
          onChange={(e) => onModeChange(e.target.value as "light" | "dark")}
          className="w-full rounded-md border border-sh-brand-gray px-3 py-2 text-sm text-sh-black focus:border-sh-blue focus:outline-none"
        >
          <option value="light">Light (white header, linen footer)</option>
          <option value="dark">Dark (full-dark site on brand colors)</option>
        </select>
        <p className="mt-1 text-xs text-sh-gray">
          Affects the public marketing site only — the back-office stays unchanged.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
        {THEME_FIELDS.map((t) => {
          const themeKey = t.key as keyof typeof settings.theme;
          return (
            <div key={t.key}>
              <label htmlFor={`theme-${t.key}`} className="mb-1 block text-sm text-sh-gray">
                {t.label}
              </label>
              <div className="flex items-center gap-2">
                <input
                  id={`theme-${t.key}`}
                  type="color"
                  value={settings.theme[themeKey] ?? "#000000"}
                  onChange={(e) => onChange(t.key, e.target.value)}
                  className="h-10 w-12 cursor-pointer rounded border border-sh-brand-gray"
                />
                <input
                  type="text"
                  aria-label={`${t.label} hex`}
                  value={settings.theme[themeKey] ?? ""}
                  onChange={(e) => onChange(t.key, e.target.value)}
                  className="w-full rounded-md border border-sh-brand-gray px-2 py-2 font-mono text-xs text-sh-black focus:border-sh-blue focus:outline-none"
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function LocalizationSection({
  settings,
  onChange,
}: Readonly<{
  settings: ResolvedAppSettings;
  onChange: (key: StringSettingKey, value: string) => void;
}>) {
  return (
    <section className="space-y-4">
      <h2 className="font-serif text-lg text-sh-blue">Localization</h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {(["currency", "locale", "timezone"] as const).map((key) => (
          <div key={key}>
            <label htmlFor={`loc-${key}`} className="mb-1 block text-sm capitalize text-sh-gray">
              {key}
            </label>
            <input
              id={`loc-${key}`}
              type="text"
              value={settings[key]}
              onChange={(e) => onChange(key, e.target.value)}
              className="w-full rounded-md border border-sh-brand-gray px-3 py-2 text-sh-black focus:border-sh-blue focus:outline-none"
            />
          </div>
        ))}
      </div>
    </section>
  );
}

type BookingField = {
  key: keyof ResolvedAppSettings["bookingConfig"];
  label: string;
  min: number;
  max: number;
};

const BOOKING_FIELDS: BookingField[] = [
  { key: "windowDays", label: "Booking window (days)", min: 1, max: 90 },
  { key: "startHour", label: "Start hour (0–23)", min: 0, max: 23 },
  { key: "endHour", label: "End hour (1–24)", min: 1, max: 24 },
  { key: "slotMinutes", label: "Slot length (minutes)", min: 5, max: 240 },
];

function BookingSection({
  config,
  onChange,
}: Readonly<{
  config: ResolvedAppSettings["bookingConfig"];
  onChange: (key: BookingField["key"], value: number) => void;
}>) {
  return (
    <section className="space-y-4">
      <h2 className="font-serif text-lg text-sh-blue">Booking</h2>
      <p className="text-xs text-sh-gray">
        Controls the public availability picker: how far ahead customers can book, daily business
        hours, and the length of each slot.
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
        {BOOKING_FIELDS.map((f) => (
          <div key={f.key}>
            <label htmlFor={`booking-${f.key}`} className="mb-1 block text-sm text-sh-gray">
              {f.label}
            </label>
            <input
              id={`booking-${f.key}`}
              type="number"
              min={f.min}
              max={f.max}
              value={config[f.key]}
              onChange={(e) => onChange(f.key, Number(e.target.value))}
              className="w-full rounded-md border border-sh-brand-gray px-3 py-2 text-sh-black focus:border-sh-blue focus:outline-none"
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function ModulesSection({
  features,
  onToggle,
}: Readonly<{
  features: Record<string, boolean>;
  onToggle: (key: string, enabled: boolean) => void;
}>) {
  // Core modules always appear here, on or off. Addon modules (niche /
  // single-tenant, e.g. dmarcTools) only appear once already enabled -- see
  // lib/modules/index.ts getToggleableModules and docs/domains/modules.md.
  const toggleable = getToggleableModules(features);
  return (
    <section className="space-y-4">
      <h2 className="font-serif text-lg text-sh-blue">Modules</h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {toggleable.map((m) => (
          <label
            key={m.key}
            htmlFor={`feature-${m.key}`}
            className="flex cursor-pointer items-start gap-3 rounded-md border border-sh-brand-gray p-3"
          >
            <input
              id={`feature-${m.key}`}
              type="checkbox"
              checked={features[m.key] ?? false}
              onChange={(e) => onToggle(m.key, e.target.checked)}
              className="mt-1 h-4 w-4"
            />
            <span>
              <span className="block text-sm font-medium text-sh-black">{m.name}</span>
              <span className="block text-xs text-sh-gray">{m.description}</span>
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}

// Index of enabled modules that declare their own settings page (a `settings`
// and/or `nav` manifest entry). A module with neither has nothing beyond its
// on/off switch above, so it doesn't get a card here -- there'd be nowhere
// useful to send the click. Deliberately NOT the shared CardGrid component:
// CardGrid re-fetches role + features client-side for a whole hub page; this
// is a subsection of a page that already has `features` loaded, and needs an
// <h2> here, not another page-level <h1>.
function ModuleSettingsIndex({
  features,
}: Readonly<{
  features: Record<string, boolean>;
}>) {
  const items = getModulesForSettingsIndex(features);
  if (items.length === 0) return null;
  return (
    <section className="space-y-4">
      <div>
        <h2 className="font-serif text-lg text-sh-blue">Module settings</h2>
        <p className="text-xs text-sh-gray">
          Enabled modules with their own settings or linked pages. Disabled modules don&apos;t
          appear here.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {items.map((m) => (
          <Link
            key={m.key}
            href={`/app/admin/settings/${m.key}`}
            className="block rounded-md border border-sh-brand-gray p-3 transition hover:border-sh-blue"
          >
            <span className="block text-sm font-medium text-sh-black">{m.name}</span>
            <span className="block text-xs text-sh-gray">{m.description}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

export function SettingsOverviewView() {
  const [settings, setSettings] = useState<ResolvedAppSettings | null>(null);
  const [features, setFeatures] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/settings");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(serverError(data, "Failed to load settings"));
      setSettings(data.settings);
      setFeatures(
        Object.fromEntries(
          MODULES.map((m) => [m.key, isFeatureEnabled(data.settings.features ?? {}, m.key)]),
        ),
      );
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load settings"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setText = (key: StringSettingKey, value: string) =>
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));

  const setThemeColor = (key: string, value: string) =>
    setSettings((prev) => (prev ? { ...prev, theme: { ...prev.theme, [key]: value } } : prev));

  const setBookingConfig = (key: keyof ResolvedAppSettings["bookingConfig"], value: number) =>
    setSettings((prev) =>
      prev ? { ...prev, bookingConfig: { ...prev.bookingConfig, [key]: value } } : prev,
    );

  const saveSettings = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appName: settings.appName,
          companyName: settings.companyName,
          tagline: settings.tagline,
          supportEmail: settings.supportEmail,
          logoUrl: settings.logoUrl,
          loginLogoUrl: settings.loginLogoUrl,
          faviconUrl: settings.faviconUrl,
          currency: settings.currency,
          locale: settings.locale,
          timezone: settings.timezone,
          theme: { ...settings.theme, mode: settings.themeMode },
          features,
          bookingConfig: settings.bookingConfig,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(serverError(data, "Failed to save settings"));
      setSettings(data.settings);
      toast.success("Settings saved. Reload to see theme changes.");
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to save settings"));
    } finally {
      setSaving(false);
    }
  };

  if (loading || !settings) {
    return (
      <div className="flex items-center gap-2 p-8 text-sh-gray">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading settings…
      </div>
    );
  }

  return (
    <div className="space-y-10 pb-16">
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-2xl text-sh-blue">Settings</h1>
        <div className="flex items-center gap-2">
          <Link
            href="/app/admin/settings/integrations"
            className="inline-flex items-center justify-center rounded-lg border border-sh-gray px-4 py-2 font-serif-condensed text-sm font-semibold tracking-wide text-sh-blue shadow-md transition hover:bg-sh-gray/10"
          >
            Integrations
          </Link>
          <Button onClick={saveSettings} disabled={saving}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save changes
          </Button>
        </div>
      </div>

      <BrandingSection settings={settings} onChange={setText} />
      <ThemeSection
        settings={settings}
        onChange={setThemeColor}
        onModeChange={(mode) => setSettings((prev) => (prev ? { ...prev, themeMode: mode } : prev))}
      />
      <LocalizationSection settings={settings} onChange={setText} />
      <BookingSection config={settings.bookingConfig} onChange={setBookingConfig} />
      <ModulesSection
        features={features}
        onToggle={(key, enabled) => setFeatures((prev) => ({ ...prev, [key]: enabled }))}
      />
      <ModuleSettingsIndex features={features} />
    </div>
  );
}
