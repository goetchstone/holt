"use client";

// /app/src/app/(dashboard)/app/admin/settings/configuration/TrafficStoreMappingPanel.tsx
//
// Per-StoreLocation editor for the counter source names that used to be the
// hardcoded AXPER_TO_STORE_LOCATION / STORE_DISPLAY_NAMES literals in
// lib/storeColors.ts (docs/domains/config-presets.md). This is the concrete
// payoff of the whole preset system: an operator adds a store's Axper door
// label here instead of filing a code change.
//
// IMPORTANT correctness note: applyPreset.ts's traffic-store-mapping apply
// is DECLARATIVE over the WHOLE preset, not per-store. It looks at what this
// preset (by name) previously claimed (via ConfigChangeLog) and clears any
// store no longer listed. So every save from this panel submits the FULL
// current set of stores and their source names -- editing one store's chips
// must never send a bundle containing only that one store, or every OTHER
// store this preset owns would be cleared on apply. buildBundle() below
// always maps over the complete `stores` state, not just the edited row.
//
// Unmapped source names (TrafficSnapshot.axperStoreName values with no
// owning store) are shown as one-click "assign to store" suggestions, so an
// operator does not need to already know a raw counter label exists to map
// it -- they see it and pick a store from a dropdown.

import { useMemo, useState } from "react";
import { toast } from "react-toastify";
import { Loader2, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";
import { parsePresetBundle, PRESET_SCHEMA_VERSION } from "@/lib/config/presetSchema";
import type { PresetBundle } from "@/lib/config/presetSchema";
import { TRAFFIC_STORE_MAPPING_PRESET_NAME } from "@/lib/config/presetApiTypes";
import type { ApplyResultSummary, StoreLocationSummary } from "@/lib/config/presetApiTypes";
import { applyConfigBundle } from "./configClient";
import { ApplyPreview } from "./ApplyPreview";

interface EditableStore {
  id: number;
  name: string;
  isActive: boolean;
  sourceNames: string[];
}

function toEditable(stores: StoreLocationSummary[]): EditableStore[] {
  return stores.map((s) => ({
    id: s.id,
    name: s.name,
    isActive: s.isActive,
    sourceNames: [...s.trafficSourceNames],
  }));
}

export type ApplyOutcomeSummary = "failed" | "no-op" | "saved";

/**
 * Classifies an apply result for the confirm toast. "no-op" is distinct
 * from "saved": every result came back UNCHANGED, meaning the server wrote
 * nothing, even though reaching handleConfirm requires `dirty` to have been
 * true (the button is disabled otherwise) -- so the operator DID change
 * something locally. Treating that as "saved" is exactly the "reports
 * success but writes nothing" bug: the most common way to land here is
 * removing a store's LAST counter name, which drops that store from the
 * submitted bundle entirely (the schema requires sourceNames.min(1) per
 * store — see buildBundle below) and relies on THIS preset's own
 * ConfigChangeLog history to notice the drop and clear it. If that store
 * was never claimed under TRAFFIC_STORE_MAPPING_PRESET_NAME — a
 * differently-named CLI preset owns it instead; see that constant's comment
 * in presetApiTypes.ts — there is nothing for this identity to release, and
 * the apply is a genuine no-op. The operator still needs to know that,
 * rather than see a green "saved" toast for an edit that didn't take.
 */
export function summarizeApplyOutcome(results: ApplyResultSummary[]): ApplyOutcomeSummary {
  if (results.some((r) => r.action === "FAILED")) return "failed";
  if (results.length > 0 && results.every((r) => r.action === "UNCHANGED")) return "no-op";
  return "saved";
}

function buildBundle(stores: EditableStore[]): PresetBundle {
  return {
    version: PRESET_SCHEMA_VERSION,
    presets: [
      {
        kind: "traffic-store-mapping",
        name: TRAFFIC_STORE_MAPPING_PRESET_NAME,
        stores: stores
          .filter((s) => s.sourceNames.length > 0)
          .map((s) => ({ storeLocation: s.name, sourceNames: [...new Set(s.sourceNames)] })),
      },
    ],
  };
}

export function TrafficStoreMappingPanel({
  storeLocations,
  unmappedTrafficSourceNames,
  onSaved,
}: Readonly<{
  storeLocations: StoreLocationSummary[];
  unmappedTrafficSourceNames: string[];
  onSaved: () => void;
}>) {
  const [stores, setStores] = useState<EditableStore[]>(() => toEditable(storeLocations));
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [assignTo, setAssignTo] = useState<Record<string, string>>({});
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState<ApplyResultSummary[] | null>(null);
  const [pendingBundle, setPendingBundle] = useState<PresetBundle | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);

  // Re-derive "still unmapped" from local edits so assigning a name updates
  // the suggestion list immediately, without waiting on a save + reload.
  const stillUnmapped = useMemo(() => {
    const claimed = new Set(
      stores.flatMap((s) => s.sourceNames.map((n) => n.trim().toLowerCase())),
    );
    return unmappedTrafficSourceNames.filter((n) => !claimed.has(n.trim().toLowerCase()));
  }, [stores, unmappedTrafficSourceNames]);

  const dirty = useMemo(() => {
    const original = toEditable(storeLocations);
    if (original.length !== stores.length) return true;
    return stores.some((s, i) => {
      const o = original[i];
      const a = [...s.sourceNames].sort();
      const b = [...o.sourceNames].sort();
      return a.length !== b.length || a.some((v, j) => v !== b[j]);
    });
  }, [stores, storeLocations]);

  function clearPreview() {
    setPreview(null);
    setPendingBundle(null);
  }

  function addSourceName(storeId: number, raw: string) {
    const name = raw.trim();
    if (!name) return;
    setStores((prev) =>
      prev.map((s) =>
        s.id === storeId && !s.sourceNames.some((n) => n.toLowerCase() === name.toLowerCase())
          ? { ...s, sourceNames: [...s.sourceNames, name] }
          : s,
      ),
    );
    setDrafts((prev) => ({ ...prev, [storeId]: "" }));
    clearPreview();
  }

  function removeSourceName(storeId: number, name: string) {
    setStores((prev) =>
      prev.map((s) =>
        s.id === storeId ? { ...s, sourceNames: s.sourceNames.filter((n) => n !== name) } : s,
      ),
    );
    clearPreview();
  }

  function assignUnmapped(name: string) {
    const storeIdRaw = assignTo[name];
    if (!storeIdRaw) return;
    addSourceName(Number(storeIdRaw), name);
  }

  async function handlePreview() {
    setFormErrors([]);
    const bundle = buildBundle(stores);
    const clientCheck = parsePresetBundle(bundle);
    if (!clientCheck.ok) {
      setFormErrors(clientCheck.errors);
      return;
    }
    setPreviewing(true);
    try {
      const { results } = await applyConfigBundle(bundle, true);
      setPreview(results);
      setPendingBundle(bundle);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to preview changes"));
    } finally {
      setPreviewing(false);
    }
  }

  async function handleConfirm() {
    if (!pendingBundle) return;
    setApplying(true);
    try {
      const { results } = await applyConfigBundle(pendingBundle, false);
      const outcome = summarizeApplyOutcome(results);
      if (outcome === "failed") {
        const failedCount = results.filter((r) => r.action === "FAILED").length;
        toast.warn(`Applied with ${failedCount} failure(s) — see details below`);
      } else if (outcome === "no-op") {
        toast.warn(
          "No changes were written — the server reports nothing to save. If you removed a store's " +
            "last counter name, this editor may not be the preset that currently owns that store; " +
            "check Config Change History for who does.",
        );
      } else {
        toast.success("Traffic store mapping saved");
      }
      setPreview(results);
      setPendingBundle(null);
      onSaved();
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to save traffic store mapping"));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="space-y-8">
      {stillUnmapped.length > 0 && (
        <section className="space-y-3 rounded-md border border-sh-gold/40 bg-sh-gold/5 p-4">
          <div>
            <h3 className="font-serif text-base text-sh-blue">Unmapped counter names</h3>
            <p className="text-xs text-sh-gray">
              Seen in traffic data but not claimed by any store. Pick a store and assign.
            </p>
          </div>
          <ul className="space-y-2">
            {stillUnmapped.map((name) => (
              <li key={name} className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-white px-2 py-1 text-sm text-sh-black shadow-sm">
                  {name}
                </span>
                <label className="sr-only" htmlFor={`assign-${name}`}>
                  Assign {name} to store
                </label>
                <select
                  id={`assign-${name}`}
                  value={assignTo[name] ?? ""}
                  onChange={(e) => setAssignTo((prev) => ({ ...prev, [name]: e.target.value }))}
                  className="rounded-md border border-sh-brand-gray px-2 py-1 text-sm text-sh-black focus:border-sh-blue focus:outline-none"
                >
                  <option value="">Choose a store…</option>
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!assignTo[name]}
                  onClick={() => assignUnmapped(name)}
                >
                  Assign
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-4">
        <h3 className="font-serif text-base text-sh-blue">Stores</h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {stores.map((store) => (
            <div key={store.id} className="rounded-md border border-sh-brand-gray p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium text-sh-black">{store.name}</span>
                {!store.isActive && (
                  <span className="rounded bg-sh-stripe px-2 py-0.5 text-[10px] uppercase text-sh-gray">
                    Inactive
                  </span>
                )}
              </div>
              <ul className="mb-2 flex flex-wrap gap-1.5">
                {store.sourceNames.length === 0 && (
                  <li className="text-xs italic text-sh-gray">No counter names mapped yet</li>
                )}
                {store.sourceNames.map((name) => (
                  <li
                    key={name}
                    className="flex items-center gap-1 rounded-full bg-sh-linen px-2 py-1 text-xs text-sh-black"
                  >
                    {name}
                    <button
                      type="button"
                      aria-label={`Remove ${name} from ${store.name}`}
                      onClick={() => removeSourceName(store.id, name)}
                      className="text-sh-gray hover:text-red-600"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-2">
                <label className="sr-only" htmlFor={`add-source-${store.id}`}>
                  Add counter name to {store.name}
                </label>
                <input
                  id={`add-source-${store.id}`}
                  type="text"
                  placeholder="Add counter name…"
                  value={drafts[store.id] ?? ""}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [store.id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addSourceName(store.id, drafts[store.id] ?? "");
                    }
                  }}
                  className="w-full rounded-md border border-sh-brand-gray px-2 py-1.5 text-sm text-sh-black focus:border-sh-blue focus:outline-none"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => addSourceName(store.id, drafts[store.id] ?? "")}
                  aria-label={`Add counter name to ${store.name}`}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {formErrors.length > 0 && (
        <ul className="list-disc space-y-0.5 rounded-md border border-red-300 bg-red-50 p-3 pl-8 text-xs text-red-700">
          {formErrors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={handlePreview} disabled={previewing || !dirty}>
          {previewing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Preview changes (dry run)
        </Button>
        {!dirty && <span className="text-xs text-sh-gray">No unsaved changes</span>}
      </div>

      {preview && (
        <section className="space-y-3 rounded-md border border-sh-brand-gray p-4">
          <h3 className="font-serif text-base text-sh-blue">Preview</h3>
          <ApplyPreview results={preview} />
          {pendingBundle && (
            <div className="flex gap-2">
              <Button onClick={handleConfirm} disabled={applying}>
                {applying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Confirm &amp; apply
              </Button>
              <Button variant="outline" onClick={clearPreview} disabled={applying}>
                Cancel
              </Button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
