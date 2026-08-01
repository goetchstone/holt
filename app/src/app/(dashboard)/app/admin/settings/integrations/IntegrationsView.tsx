"use client";

// /app/src/app/(dashboard)/app/admin/settings/integrations/IntegrationsView.tsx
//
// Integrations body, split out of the old monolithic SettingsView.tsx (which
// stacked Branding/Theme/Localization/Booking/Modules/Integrations on one
// page -- see docs/domains/modules.md for why). Unchanged behavior: renders
// generically from lib/integrationCatalog.ts INTEGRATION_PROVIDERS via the
// shared /api/admin/settings/integrations{,/test} REST endpoints. Credentials
// are encrypted at rest and never returned -- entering a new value replaces
// the stored one.

import { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";
import { INTEGRATION_PROVIDERS } from "@/lib/integrationCatalog";

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

export function IntegrationsView() {
  const [credentials, setCredentials] = useState<MaskedCred[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [testResults, setTestResults] = useState<Record<string, TestState>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/settings/integrations");
      if (res.ok) setCredentials((await res.json()).credentials ?? []);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load integrations"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setDraft = (draftKey: string, value: string) =>
    setDrafts((prev) => ({ ...prev, [draftKey]: value }));

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

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sh-gray">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading integrations…
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-16">
      <div>
        <h1 className="font-serif text-2xl text-sh-blue">Integrations</h1>
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
    </div>
  );
}
