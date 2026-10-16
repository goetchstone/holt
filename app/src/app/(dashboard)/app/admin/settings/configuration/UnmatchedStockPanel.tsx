"use client";

// /app/src/app/(dashboard)/app/admin/settings/configuration/UnmatchedStockPanel.tsx
//
// Which store's "Unmatched — Needs Review" place takes POS stock rows the import
// cannot match to a place (AppSettings.unmatchedStockStoreLocationId). It used
// to be a store found by the name "Warehouse" (rule 61). With none chosen the
// import reports such rows and writes none of them (rule 63), so stock is never
// recorded at a store nobody picked.

import { useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

interface StoreOption {
  id: number;
  name: string;
}

export function UnmatchedStockPanel() {
  const [stores, setStores] = useState<StoreOption[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [saved, setSaved] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [settingsRes, storesRes] = await Promise.all([
          axios.get<{ settings: { unmatchedStockStoreLocationId: number | null } }>(
            "/api/admin/settings",
          ),
          axios.get<{ locations: (StoreOption & { isActive: boolean })[] }>("/api/store-locations"),
        ]);
        if (cancelled) return;
        setStores(storesRes.data.locations.filter((s) => s.isActive));
        const current = settingsRes.data.settings.unmatchedStockStoreLocationId;
        setSelected(current ? String(current) : "");
        setSaved(current ? String(current) : "");
      } catch (err) {
        if (!cancelled)
          toast.error(getErrorMessage(err, "Could not load the stock import setting"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await axios.put("/api/admin/settings", {
        unmatchedStockStoreLocationId: selected ? Number(selected) : null,
      });
      setSaved(selected);
      toast.success("Unmatched-stock store updated");
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not save"));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-brand-gray">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-3 p-1">
      <h3 className="text-sm text-brand-black">Unmatched stock</h3>
      <p className="text-xs text-brand-gray">
        When the stock import meets a POS location that matches no stock location, its units go to
        an &quot;Unmatched — Needs Review&quot; place at this store, with the POS name kept so you
        can add an alias. With no store chosen, those rows are reported and not imported.
      </p>
      <label htmlFor="unmatched-stock-store" className="sr-only">
        Unmatched-stock store
      </label>
      <select
        id="unmatched-stock-store"
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        className="border border-brand-gray/30 rounded px-2 py-1 text-sm"
      >
        <option value="">None: report unmatched rows only</option>
        {stores.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <div>
        <Button onClick={save} disabled={saving || selected === saved}>
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Save
        </Button>
      </div>
    </div>
  );
}
