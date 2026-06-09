"use client";

// /app/src/app/(dashboard)/app/admin/settings/SettingsView.tsx
//
// Settings body. App Router port of the legacy admin/settings page (minus
// MainLayout chrome + next/head, supplied by the (dashboard) layout). Edits
// branding, theme colors, localization, feature modules, and encrypted
// integration credentials (with per-provider Test Connection) via the shared
// /api/admin/settings REST endpoints. Credentials are encrypted at rest and
// never returned -- entering a new value replaces the stored one.

import { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { Loader2, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";
import { INTEGRATION_PROVIDERS } from "@/lib/integrationCatalog";
import { FEATURES, isFeatureEnabled } from "@/lib/featureCatalog";
import { ImageUploadField } from "@/components/cms/admin/ImageUploadField";
import type { ResolvedAppSettings } from "@/lib/appSettings";

interface MaskedCred {
  provider: string;
  field: string;
  lastFour: string | null;
  updated: string | null;
}

interface TestResult {
  ok: boolean;
  level: string;
  message: string;
}

type TestState = TestResult | "loading";

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
}: Readonly<{
  settings: ResolvedAppSettings;
  onChange: (key: string, value: string) => void;
}>) {
  return (
    <section className="space-y-4">
      <h2 className="font-serif text-lg text-sh-blue">Theme colors</h2>
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
  return (
    <section className="space-y-4">
      <h2 className="font-serif text-lg text-sh-blue">Modules</h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {FEATURES.map((f) => (
          <label
            key={f.key}
            htmlFor={`feature-${f.key}`}
            className="flex cursor-pointer items-start gap-3 rounded-md border border-sh-brand-gray p-3"
          >
            <input
              id={`feature-${f.key}`}
              type="checkbox"
              checked={features[f.key] ?? false}
              onChange={(e) => onToggle(f.key, e.target.checked)}
              className="mt-1 h-4 w-4"
            />
            <span>
              <span className="block text-sm font-medium text-sh-black">{f.name}</span>
              <span className="block text-xs text-sh-gray">{f.description}</span>
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}

function TestResultBadge({ state }: Readonly<{ state: TestState | undefined }>) {
  if (!state || state === "loading") return null;
  return (
    <span
      className={`max-w-[220px] text-right text-xs ${state.ok ? "text-green-700" : "text-red-600"}`}
    >
      {state.ok ? "✓ " : "✗ "}
      {state.message}
    </span>
  );
}

function IntegrationCard({
  provider,
  drafts,
  testState,
  maskFor,
  onDraft,
  onSave,
  onClear,
  onTest,
}: Readonly<{
  provider: (typeof INTEGRATION_PROVIDERS)[number];
  drafts: Record<string, string>;
  testState: TestState | undefined;
  maskFor: (provider: string, field: string) => string;
  onDraft: (draftKey: string, value: string) => void;
  onSave: (provider: string, field: string) => void;
  onClear: (provider: string, field: string) => void;
  onTest: (provider: string) => void;
}>) {
  return (
    <div className="rounded-md border border-sh-brand-gray p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-sh-black">{provider.name}</h3>
          <p className="text-xs text-sh-gray">{provider.description}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onTest(provider.id)}
            disabled={testState === "loading"}
          >
            {testState === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Test"}
          </Button>
          <TestResultBadge state={testState} />
        </div>
      </div>
      <div className="space-y-3">
        {provider.fields.map((field) => {
          const draftKey = `${provider.id}.${field.key}`;
          return (
            <div key={field.key} className="flex flex-wrap items-end gap-2">
              <div className="min-w-[200px] flex-1">
                <label htmlFor={`cred-${draftKey}`} className="mb-1 block text-xs text-sh-gray">
                  {field.label}{" "}
                  <span className="text-sh-brand-gray">({maskFor(provider.id, field.key)})</span>
                </label>
                <input
                  id={`cred-${draftKey}`}
                  type="password"
                  autoComplete="new-password"
                  placeholder={field.placeholder ?? "Enter new value"}
                  value={drafts[draftKey] ?? ""}
                  onChange={(e) => onDraft(draftKey, e.target.value)}
                  className="w-full rounded-md border border-sh-brand-gray px-3 py-2 text-sh-black focus:border-sh-blue focus:outline-none"
                />
              </div>
              <Button variant="secondary" size="sm" onClick={() => onSave(provider.id, field.key)}>
                Save
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onClear(provider.id, field.key)}
                aria-label={`Clear ${provider.name} ${field.label}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SettingsView() {
  const [settings, setSettings] = useState<ResolvedAppSettings | null>(null);
  const [features, setFeatures] = useState<Record<string, boolean>>({});
  const [credentials, setCredentials] = useState<MaskedCred[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, TestState>>({});

  const load = useCallback(async () => {
    try {
      const [sRes, cRes] = await Promise.all([
        fetch("/api/admin/settings"),
        fetch("/api/admin/settings/integrations"),
      ]);
      const sData = await sRes.json().catch(() => ({}));
      if (!sRes.ok) throw new Error(serverError(sData, "Failed to load settings"));
      setSettings(sData.settings);
      setFeatures(
        Object.fromEntries(
          FEATURES.map((f) => [f.key, isFeatureEnabled(sData.settings.features ?? {}, f.key)]),
        ),
      );
      if (cRes.ok) setCredentials((await cRes.json()).credentials ?? []);
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

  const setDraft = (draftKey: string, value: string) =>
    setDrafts((prev) => ({ ...prev, [draftKey]: value }));

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
          theme: settings.theme,
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

  const saveCredential = async (provider: string, field: string) => {
    const draftKey = `${provider}.${field}`;
    const value = drafts[draftKey];
    if (!value || value.trim() === "") return;
    try {
      const res = await fetch("/api/admin/settings/integrations", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, field, value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(serverError(data, "Failed to save credential"));
      setCredentials(data.credentials ?? []);
      setDrafts((prev) => ({ ...prev, [draftKey]: "" }));
      toast.success("Saved");
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to save credential"));
    }
  };

  const clearCredential = async (provider: string, field: string) => {
    try {
      const res = await fetch("/api/admin/settings/integrations", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, field }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(serverError(data, "Failed to clear credential"));
      setCredentials(data.credentials ?? []);
      toast.success("Cleared");
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to clear credential"));
    }
  };

  const testConnection = async (provider: string) => {
    setTestResults((prev) => ({ ...prev, [provider]: "loading" }));
    try {
      const res = await fetch("/api/admin/settings/integrations/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(serverError(data, "Test failed"));
      setTestResults((prev) => ({ ...prev, [provider]: data }));
    } catch (err: unknown) {
      setTestResults((prev) => ({
        ...prev,
        [provider]: { ok: false, level: "failed", message: getErrorMessage(err, "Test failed") },
      }));
    }
  };

  const maskFor = (provider: string, field: string): string => {
    const found = credentials.find((c) => c.provider === provider && c.field === field);
    if (!found) return "Not set";
    return found.lastFour ? `•••• ${found.lastFour}` : "Set";
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
        <Button onClick={saveSettings} disabled={saving}>
          {saving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          Save changes
        </Button>
      </div>

      <BrandingSection settings={settings} onChange={setText} />
      <ThemeSection settings={settings} onChange={setThemeColor} />
      <LocalizationSection settings={settings} onChange={setText} />
      <BookingSection config={settings.bookingConfig} onChange={setBookingConfig} />
      <ModulesSection
        features={features}
        onToggle={(key, enabled) => setFeatures((prev) => ({ ...prev, [key]: enabled }))}
      />

      <section className="space-y-6">
        <div>
          <h2 className="font-serif text-lg text-sh-blue">Integrations</h2>
          <p className="text-xs text-sh-gray">
            Keys are encrypted at rest and never shown again. Enter a new value to replace one.
          </p>
        </div>
        {INTEGRATION_PROVIDERS.map((p) => (
          <IntegrationCard
            key={p.id}
            provider={p}
            drafts={drafts}
            testState={testResults[p.id]}
            maskFor={maskFor}
            onDraft={setDraft}
            onSave={saveCredential}
            onClear={clearCredential}
            onTest={testConnection}
          />
        ))}
      </section>
    </div>
  );
}
