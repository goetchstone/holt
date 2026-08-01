"use client";

// /app/src/app/(dashboard)/app/admin/settings/configuration/ImportExportPanel.tsx
//
// The GitOps <-> GUI bridge: download the live DB as a YAML/JSON file (to
// commit into config/local/), or paste/upload a file and apply it here. This
// is the panel the owner's requirement is most literally about — "it must
// export back to a file so a change made in the browser can be committed."
//
// Validate is a separate step from apply on purpose: it lets the paste/
// upload box show schema errors (POST .../validate) before anything is
// sent to the write path, and only a bundle that has already validated
// clean can reach the dry-run preview button.

import { useState } from "react";
import { toast } from "react-toastify";
import { Download, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { FileInput } from "@/components/ui/file-input";
import { getErrorMessage } from "@/lib/toastError";
import { detectFormat, type PresetFormat } from "@/lib/config/presetSerialize";
import type { PresetBundle } from "@/lib/config/presetSchema";
import type { ApplyResultSummary } from "@/lib/config/presetApiTypes";
import { applyConfigBundle, exportUrl, validateConfigText } from "./configClient";
import { ApplyPreview } from "./ApplyPreview";

type FormatChoice = "auto" | PresetFormat;

const SAMPLE_PLACEHOLDER = [
  "version: 1",
  "presets:",
  "  - kind: traffic-store-mapping",
  "    name: traffic-stores",
  "    stores: []",
].join("\n");

export function ImportExportPanel({ onSaved }: Readonly<{ onSaved: () => void }>) {
  const [text, setText] = useState("");
  const [formatChoice, setFormatChoice] = useState<FormatChoice>("auto");
  const [validating, setValidating] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[] | null>(null);
  const [validBundle, setValidBundle] = useState<PresetBundle | null>(null);
  const [preview, setPreview] = useState<ApplyResultSummary[] | null>(null);
  const [pendingBundle, setPendingBundle] = useState<PresetBundle | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);

  function resetValidation() {
    setValidationErrors(null);
    setValidBundle(null);
    setPreview(null);
    setPendingBundle(null);
  }

  function handleFile(file: File | null) {
    if (!file) return;
    const detected = detectFormat(file.name);
    if (detected) setFormatChoice(detected);
    const reader = new FileReader();
    reader.onload = () => {
      setText(String(reader.result ?? ""));
      resetValidation();
    };
    reader.readAsText(file);
  }

  async function handleValidate() {
    resetValidation();
    setValidating(true);
    try {
      const format = formatChoice === "auto" ? undefined : formatChoice;
      const result = await validateConfigText(text, format);
      if (!result.ok) {
        setValidationErrors(result.errors);
        return;
      }
      setValidBundle(result.bundle);
      toast.success(`Valid — ${result.bundle.presets.length} preset(s) found`);
    } catch (err) {
      toast.error(getErrorMessage(err, "Validation failed"));
    } finally {
      setValidating(false);
    }
  }

  async function handlePreview() {
    if (!validBundle) return;
    setPreviewing(true);
    try {
      const { results } = await applyConfigBundle(validBundle, true);
      setPreview(results);
      setPendingBundle(validBundle);
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
      const failed = results.filter((r) => r.action === "FAILED");
      if (failed.length > 0) {
        toast.warn(`Applied with ${failed.length} failure(s) — see details below`);
      } else {
        toast.success("Configuration applied");
      }
      setPreview(results);
      setPendingBundle(null);
      onSaved();
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to apply configuration"));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h3 className="font-serif text-base text-sh-blue">Download current config</h3>
        <p className="text-xs text-sh-gray">
          Exports the live database as a preset bundle — deterministic key order, so committing an
          unchanged re-export is never a spurious diff.
        </p>
        <div className="flex gap-2">
          <a
            href={exportUrl("yaml")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-sh-gray px-4 py-2 font-serif-condensed text-sm font-semibold tracking-wide text-sh-blue shadow-md transition hover:bg-sh-gray/10"
          >
            <Download className="h-4 w-4" /> YAML
          </a>
          <a
            href={exportUrl("json")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-sh-gray px-4 py-2 font-serif-condensed text-sm font-semibold tracking-wide text-sh-blue shadow-md transition hover:bg-sh-gray/10"
          >
            <Download className="h-4 w-4" /> JSON
          </a>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="font-serif text-base text-sh-blue">Paste or upload a config file</h3>
        <div className="flex flex-wrap items-end gap-4">
          <FileInput
            label="Upload .yaml / .yml / .json"
            accept=".yaml,.yml,.json"
            onChange={handleFile}
          />
          <div>
            <label htmlFor="import-format" className="mb-1 block text-sm text-sh-gray">
              Format
            </label>
            <select
              id="import-format"
              value={formatChoice}
              onChange={(e) => {
                setFormatChoice(e.target.value as FormatChoice);
                resetValidation();
              }}
              className="rounded-md border border-sh-brand-gray px-3 py-2 text-sm text-sh-black focus:border-sh-blue focus:outline-none"
            >
              <option value="auto">Auto-detect</option>
              <option value="yaml">YAML</option>
              <option value="json">JSON</option>
            </select>
          </div>
        </div>
        <div>
          <label htmlFor="import-text" className="mb-1 block text-sm text-sh-gray">
            Preset text
          </label>
          <textarea
            id="import-text"
            rows={14}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              resetValidation();
            }}
            placeholder={SAMPLE_PLACEHOLDER}
            className="w-full rounded-md border border-sh-brand-gray px-3 py-2 font-mono text-xs text-sh-black focus:border-sh-blue focus:outline-none"
          />
        </div>
        <Button onClick={handleValidate} disabled={validating || !text.trim()}>
          {validating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Validate
        </Button>

        {validationErrors && (
          <ul className="list-disc space-y-0.5 rounded-md border border-red-300 bg-red-50 p-3 pl-8 text-xs text-red-700">
            {validationErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}

        {validBundle && !preview && (
          <div className="space-y-2 rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-800">
            <p>Valid — {validBundle.presets.length} preset(s) found.</p>
            <Button onClick={handlePreview} disabled={previewing}>
              {previewing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Preview changes (dry run)
            </Button>
          </div>
        )}

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
                <Button
                  variant="outline"
                  onClick={() => {
                    setPreview(null);
                    setPendingBundle(null);
                  }}
                  disabled={applying}
                >
                  Cancel
                </Button>
              </div>
            )}
          </section>
        )}
      </section>
    </div>
  );
}
