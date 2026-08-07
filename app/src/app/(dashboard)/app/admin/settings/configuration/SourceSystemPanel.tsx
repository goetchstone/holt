"use client";

// /app/src/app/(dashboard)/app/admin/settings/configuration/SourceSystemPanel.tsx
//
// Picks which SourceAdapter (lib/adapters/) this deployment pulls from.
//
// This lives on the Configuration page rather than with branding/modules
// because it answers the same question the other panels do: how is THIS
// deployment wired to the world it came from. Unlike its neighbours it is not
// a config preset -- the selection is a single AppSettings column, saved
// through /api/admin/settings, because there is exactly one active adapter and
// nothing declarative to diff.
//
// The list comes from the server's registry. Hardcoding it here would
// reintroduce the coupling the registry exists to remove -- a new adapter must
// show up in this picker by being registered, not by someone remembering to
// edit a second list.

import { useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

interface AdapterOption {
  id: string;
  label: string;
  description: string;
}

interface Readiness {
  ready: boolean;
  reason?: string;
}

export function SourceSystemPanel() {
  const [options, setOptions] = useState<AdapterOption[]>([]);
  const [selected, setSelected] = useState<string>("none");
  const [saved, setSaved] = useState<string>("none");
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await axios.get<{
          settings: { sourceAdapterId: string };
          sourceAdapters: AdapterOption[];
        }>("/api/admin/settings");
        if (cancelled) return;
        setOptions(res.data.sourceAdapters);
        setSelected(res.data.settings.sourceAdapterId);
        setSaved(res.data.settings.sourceAdapterId);
      } catch (err) {
        if (!cancelled) toast.error(getErrorMessage(err, "Could not load source settings"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Readiness is checked against what is SAVED, not what is selected -- an
  // unsaved pick has no credentials to check yet, and reporting "not ready"
  // for a choice the operator has not committed reads as an error they caused.
  useEffect(() => {
    let cancelled = false;
    if (saved === "none") {
      setReadiness(null);
      return;
    }
    (async () => {
      try {
        const res = await axios.get<Readiness>("/api/automations/source-readiness");
        if (!cancelled) setReadiness(res.data);
      } catch {
        // A readiness probe that fails is not worth a toast -- the panel just
        // shows nothing rather than claiming a state it does not know.
        if (!cancelled) setReadiness(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [saved]);

  const save = async () => {
    setSaving(true);
    try {
      await axios.put("/api/admin/settings", { sourceAdapterId: selected });
      setSaved(selected);
      toast.success("Source system updated");
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not save"));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sh-gray">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-4 p-1">
      <p className="text-xs text-sh-gray">
        The system this deployment ran before holt, and keeps pulling from on a schedule. Scheduled
        imports use whichever adapter is selected here. <strong>No source system</strong> is a real
        answer — a deployment that keys everything in holt imports nothing.
      </p>

      <div className="space-y-2">
        {options.map((opt) => (
          <label
            key={opt.id}
            className="flex cursor-pointer items-start gap-3 rounded border border-sh-linen p-3 hover:bg-sh-linen/40"
          >
            <input
              type="radio"
              name="sourceAdapter"
              className="mt-1"
              value={opt.id}
              checked={selected === opt.id}
              onChange={() => setSelected(opt.id)}
            />
            <span>
              <span className="block text-sm text-sh-black">{opt.label}</span>
              <span className="block text-xs text-sh-gray">{opt.description}</span>
            </span>
          </label>
        ))}
      </div>

      {readiness && (
        <div
          className={`flex items-start gap-2 rounded border p-3 text-xs ${
            readiness.ready
              ? "border-green-200 bg-green-50 text-green-900"
              : "border-amber-200 bg-amber-50 text-amber-900"
          }`}
        >
          {readiness.ready ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <span>{readiness.ready ? "Configured and ready to import." : readiness.reason}</span>
        </div>
      )}

      <Button onClick={save} disabled={saving || selected === saved}>
        {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
        Save
      </Button>
    </div>
  );
}
