"use client";

// /app/src/app/(dashboard)/app/admin/settings/configuration/ConfigurationView.tsx
//
// Admin > Settings > Configuration -- the GUI door of the config-preset
// system (docs/domains/config-presets.md), a peer of config/**/*.{yaml,json}
// rather than a lesser view of it. Loads current DB state ONCE here and
// hands it down to the Traffic Store Mapping and Import Definitions panels,
// so switching tabs doesn't re-fetch, and a save in either panel calls
// `reload` to refresh every panel from the same source.
//
// The disk-report banner (errors + overrides from loadAllPresets()) is
// page-level, not per-tab: a config/local/*.yaml file silently shadowing a
// shipped preset is relevant no matter which editor the operator has open,
// since the next GitOps apply will overwrite whatever they save here for
// that (kind, name).

import { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { Loader2 } from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getErrorMessage } from "@/lib/toastError";
import type { PresetsGetResponse } from "@/lib/config/presetApiTypes";
import type { ImportDefinitionPreset } from "@/lib/config/presetSchema";
import { fetchConfigState } from "./configClient";
import { TrafficStoreMappingPanel } from "./TrafficStoreMappingPanel";
import { ImportDefinitionsPanel } from "./ImportDefinitionsPanel";
import { ImportExportPanel } from "./ImportExportPanel";
import { ChangeHistoryPanel } from "./ChangeHistoryPanel";

function DiskReportBanner({
  diskReport,
}: Readonly<{ diskReport: PresetsGetResponse["diskReport"] }>) {
  if (diskReport.errors.length === 0 && diskReport.overrides.length === 0) return null;
  return (
    <div className="space-y-2 rounded-md border border-sh-gold/50 bg-sh-gold/5 p-4 text-sm">
      {diskReport.overrides.length > 0 && (
        <div>
          <p className="font-medium text-sh-black">
            config/local/ is overriding {diskReport.overrides.length} shipped preset
            {diskReport.overrides.length === 1 ? "" : "s"}
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-sh-gray">
            {diskReport.overrides.map((o) => (
              // Keyed by the file pair, not by kind/name: a preset can be
              // overridden more than once in a chain (shipped -> A -> B), and
              // kind/name alone collides in exactly that case.
              <li key={`${o.kind}/${o.name}:${o.shippedFile}->${o.localFile}`}>
                {o.kind}/{o.name}: {o.localFile} overrides {o.shippedFile}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-sh-gray">
            The next GitOps apply of that file will overwrite whatever is saved here for the same
            preset.
          </p>
        </div>
      )}
      {diskReport.errors.length > 0 && (
        <div>
          <p className="font-medium text-red-700">
            {diskReport.errors.length} config file{diskReport.errors.length === 1 ? "" : "s"} failed
            to load
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-red-700">
            {diskReport.errors.map((e) => (
              <li key={e.sourceFile}>
                {e.sourceFile}: {e.messages.join("; ")}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function ConfigurationView() {
  const [state, setState] = useState<PresetsGetResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const data = await fetchConfigState();
      setState(data);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to load configuration"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loading || !state) {
    return (
      <div className="flex items-center gap-2 p-8 text-sh-gray">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading configuration…
      </div>
    );
  }

  const importDefinitions = state.bundle.presets.filter(
    (p): p is ImportDefinitionPreset => p.kind === "import-definition",
  );

  return (
    <div className="space-y-6 pb-16">
      <div>
        <h1 className="font-serif text-2xl text-sh-blue">Configuration</h1>
        <p className="text-xs text-sh-gray">
          Per-deployment mappings — same schema and same rows as the YAML/JSON files under{" "}
          <code className="text-sh-black">config/</code>. A change made here can be exported back to
          a file and committed.
        </p>
      </div>

      <DiskReportBanner diskReport={state.diskReport} />

      <Tabs defaultValue="traffic">
        <TabsList>
          <TabsTrigger value="traffic">Traffic Store Mapping</TabsTrigger>
          <TabsTrigger value="imports">Import Definitions</TabsTrigger>
          <TabsTrigger value="export">Import &amp; Export</TabsTrigger>
          <TabsTrigger value="history">Change History</TabsTrigger>
        </TabsList>

        <TabsContent tabValue="traffic">
          <TrafficStoreMappingPanel
            storeLocations={state.storeLocations}
            unmappedTrafficSourceNames={state.unmappedTrafficSourceNames}
            onSaved={reload}
          />
        </TabsContent>

        <TabsContent tabValue="imports">
          <ImportDefinitionsPanel definitions={importDefinitions} onSaved={reload} />
        </TabsContent>

        <TabsContent tabValue="export">
          <ImportExportPanel onSaved={reload} />
        </TabsContent>

        <TabsContent tabValue="history">
          <ChangeHistoryPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
