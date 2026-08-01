"use client";

// /app/src/app/(dashboard)/app/admin/settings/configuration/ImportDefinitionsPanel.tsx
//
// List + editor for `import-definition` presets: field mappings (source
// column -> target field + transform + required) and value mappings
// (grouped by target field, source value -> target value).
//
// Two inputs are deliberately free-text with a <datalist> suggestion rather
// than a restrictive <select>:
//   - targetEntity: IMPORT_ENTITIES is a server-side catalog that grows, and
//     a definition can validly name an entity that does not exist YET (see
//     ordorite-payment-modes.yaml -- targetEntity "payment" -- which ships
//     forced inactive rather than rejected). A <select> would silently drop
//     that value.
//   - fieldMappings[].targetField: same reasoning, scoped to the chosen
//     entity's known field keys once it IS recognized.
// transform IS a strict <select> -- the six-key vocabulary in
// presetSchema.ts is closed on purpose (rule 62: config selects behaviour,
// it never supplies it), so there is nothing to preserve by leaving it open.
//
// Renaming an existing definition is not offered: (kind, name) is the
// identity applyPreset.ts reconciles against, so changing `name` on save
// would CREATE a new ImportDefinition under the new name rather than
// renaming the row, leaving the old one behind. The name field is only
// editable when creating a new definition.

import { useEffect, useMemo, useState } from "react";
import { toast } from "react-toastify";
import { Loader2, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getErrorMessage } from "@/lib/toastError";
import { IMPORT_ENTITIES, getImportEntity } from "@/lib/genericImport";
import {
  flattenValueMappings,
  importModeSchema,
  importSourceFormatSchema,
  importTransformSchema,
  nestValueMappings,
  parsePresetBundle,
  presetNameSchema,
  PRESET_SCHEMA_VERSION,
} from "@/lib/config/presetSchema";
import type { ImportDefinitionPreset, PresetBundle } from "@/lib/config/presetSchema";
import type { ApplyResultSummary } from "@/lib/config/presetApiTypes";
import { applyConfigBundle } from "./configClient";
import { ApplyPreview } from "./ApplyPreview";

type TransformValue = "" | (typeof importTransformSchema.options)[number];

interface FieldMappingForm {
  sourceColumn: string;
  targetField: string;
  transform: TransformValue;
  required: boolean;
}

interface ValueMappingForm {
  targetField: string;
  sourceValue: string;
  targetValue: string;
}

interface DefinitionForm {
  isNew: boolean;
  name: string;
  description: string;
  targetEntity: string;
  sourceFormat: (typeof importSourceFormatSchema.options)[number];
  importMode: (typeof importModeSchema.options)[number];
  naturalKeyFieldsText: string;
  runnerKey: string;
  isActive: boolean;
  fieldMappings: FieldMappingForm[];
  valueMappings: ValueMappingForm[];
}

const BLANK_FORM: DefinitionForm = {
  isNew: true,
  name: "",
  description: "",
  targetEntity: "",
  sourceFormat: "CSV",
  importMode: "INSERT_ONLY",
  naturalKeyFieldsText: "",
  runnerKey: "",
  isActive: true,
  fieldMappings: [],
  valueMappings: [],
};

function toForm(preset: ImportDefinitionPreset): DefinitionForm {
  return {
    isNew: false,
    name: preset.name,
    description: preset.description ?? "",
    targetEntity: preset.targetEntity,
    sourceFormat: preset.sourceFormat,
    importMode: preset.importMode,
    naturalKeyFieldsText: preset.naturalKeyFields.join(", "),
    runnerKey: preset.runnerKey ?? "",
    isActive: preset.isActive,
    fieldMappings: preset.fieldMappings.map((fm) => ({
      sourceColumn: fm.sourceColumn,
      targetField: fm.targetField,
      transform: (fm.transform ?? "") as TransformValue,
      required: fm.required,
    })),
    valueMappings: flattenValueMappings(preset.valueMappings).map((v) => ({ ...v })),
  };
}

function buildPreset(form: DefinitionForm): ImportDefinitionPreset {
  return {
    kind: "import-definition",
    name: form.name.trim(),
    description: form.description.trim() || undefined,
    targetEntity: form.targetEntity.trim(),
    sourceFormat: form.sourceFormat,
    importMode: form.importMode,
    naturalKeyFields: form.naturalKeyFieldsText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    runnerKey: form.runnerKey.trim() || undefined,
    isActive: form.isActive,
    fieldMappings: form.fieldMappings
      .filter((fm) => fm.sourceColumn.trim() && fm.targetField.trim())
      .map((fm) => ({
        sourceColumn: fm.sourceColumn.trim(),
        targetField: fm.targetField.trim(),
        transform: fm.transform || undefined,
        required: fm.required,
      })),
    valueMappings: nestValueMappings(
      form.valueMappings
        .filter((vm) => vm.targetField.trim() && vm.sourceValue.trim())
        .map((vm) => ({
          targetField: vm.targetField.trim(),
          sourceValue: vm.sourceValue.trim(),
          targetValue: vm.targetValue.trim(),
        })),
    ),
  };
}

function buildBundle(form: DefinitionForm): PresetBundle {
  return { version: PRESET_SCHEMA_VERSION, presets: [buildPreset(form)] };
}

function groupValueMappings(rows: ValueMappingForm[]): Array<{ targetField: string; indices: number[] }> {
  const order: string[] = [];
  const byField = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const key = row.targetField || "(unset target field)";
    if (!byField.has(key)) {
      byField.set(key, []);
      order.push(key);
    }
    byField.get(key)!.push(index);
  });
  return order.map((targetField) => ({ targetField, indices: byField.get(targetField)! }));
}

export function ImportDefinitionsPanel({
  definitions,
  onSaved,
}: Readonly<{
  definitions: ImportDefinitionPreset[];
  onSaved: () => void;
}>) {
  const [selectedName, setSelectedName] = useState<string | null>(
    definitions.length > 0 ? definitions[0].name : null,
  );
  const [form, setForm] = useState<DefinitionForm | null>(
    definitions.length > 0 ? toForm(definitions[0]) : null,
  );
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState<ApplyResultSummary[] | null>(null);
  const [pendingBundle, setPendingBundle] = useState<PresetBundle | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);

  // Definitions reload after every save (parent refetches GET .../presets) --
  // keep the currently selected row's form in sync with the fresh copy
  // rather than silently editing stale data.
  useEffect(() => {
    if (selectedName === null) return;
    const fresh = definitions.find((d) => d.name === selectedName);
    if (fresh) setForm(toForm(fresh));
  }, [definitions, selectedName]);

  function selectDefinition(name: string) {
    const preset = definitions.find((d) => d.name === name);
    if (!preset) return;
    setSelectedName(name);
    setForm(toForm(preset));
    setFormErrors([]);
    setPreview(null);
    setPendingBundle(null);
  }

  function startNew() {
    setSelectedName(null);
    setForm({ ...BLANK_FORM, fieldMappings: [], valueMappings: [] });
    setFormErrors([]);
    setPreview(null);
    setPendingBundle(null);
  }

  function updateForm<K extends keyof DefinitionForm>(key: K, value: DefinitionForm[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    setPreview(null);
    setPendingBundle(null);
  }

  function updateFieldMapping(index: number, patch: Partial<FieldMappingForm>) {
    setForm((prev) => {
      if (!prev) return prev;
      const fieldMappings = prev.fieldMappings.map((fm, i) => (i === index ? { ...fm, ...patch } : fm));
      return { ...prev, fieldMappings };
    });
    setPreview(null);
    setPendingBundle(null);
  }

  function addFieldMapping() {
    setForm((prev) =>
      prev
        ? {
            ...prev,
            fieldMappings: [
              ...prev.fieldMappings,
              { sourceColumn: "", targetField: "", transform: "", required: false },
            ],
          }
        : prev,
    );
  }

  function removeFieldMapping(index: number) {
    setForm((prev) =>
      prev ? { ...prev, fieldMappings: prev.fieldMappings.filter((_, i) => i !== index) } : prev,
    );
    setPreview(null);
    setPendingBundle(null);
  }

  function updateValueMapping(index: number, patch: Partial<ValueMappingForm>) {
    setForm((prev) => {
      if (!prev) return prev;
      const valueMappings = prev.valueMappings.map((vm, i) => (i === index ? { ...vm, ...patch } : vm));
      return { ...prev, valueMappings };
    });
    setPreview(null);
    setPendingBundle(null);
  }

  function addValueMapping(targetField: string) {
    setForm((prev) =>
      prev
        ? { ...prev, valueMappings: [...prev.valueMappings, { targetField, sourceValue: "", targetValue: "" }] }
        : prev,
    );
  }

  function removeValueMapping(index: number) {
    setForm((prev) =>
      prev ? { ...prev, valueMappings: prev.valueMappings.filter((_, i) => i !== index) } : prev,
    );
    setPreview(null);
    setPendingBundle(null);
  }

  const entity = useMemo(() => (form ? getImportEntity(form.targetEntity) : undefined), [form]);
  const nameError = useMemo(() => {
    if (!form || !form.isNew || !form.name) return null;
    const result = presetNameSchema.safeParse(form.name);
    return result.success ? null : result.error.issues[0]?.message ?? "Invalid name";
  }, [form]);

  async function handlePreview() {
    if (!form) return;
    setFormErrors([]);
    const bundle = buildBundle(form);
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
      const failed = results.filter((r) => r.action === "FAILED");
      if (failed.length > 0) {
        toast.warn(`Applied with ${failed.length} failure(s) — see details below`);
      } else {
        toast.success("Import definition saved");
        if (form) setSelectedName(form.name.trim());
      }
      setPreview(results);
      setPendingBundle(null);
      onSaved();
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to save import definition"));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[240px_1fr]">
      <div className="space-y-2">
        <Button variant="outline" size="sm" fullWidth onClick={startNew}>
          <Plus className="mr-1 h-4 w-4" /> New definition
        </Button>
        <ul className="space-y-1">
          {definitions.map((d) => (
            <li key={d.name}>
              <button
                type="button"
                onClick={() => selectDefinition(d.name)}
                className={`w-full rounded-md border px-3 py-2 text-left text-sm transition ${
                  selectedName === d.name
                    ? "border-sh-blue bg-sh-linen text-sh-blue"
                    : "border-sh-brand-gray text-sh-black hover:border-sh-blue"
                }`}
              >
                <span className="block font-medium">{d.name}</span>
                <span className="flex items-center gap-1 text-xs text-sh-gray">
                  {d.targetEntity}
                  {!d.isActive && <Badge variant="neutral">inactive</Badge>}
                </span>
              </button>
            </li>
          ))}
          {definitions.length === 0 && (
            <li className="text-xs text-sh-gray">No import definitions yet.</li>
          )}
        </ul>
      </div>

      {form && (
        <div className="space-y-6">
          <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="def-name" className="mb-1 block text-sm text-sh-gray">
                Name
              </label>
              <input
                id="def-name"
                type="text"
                value={form.name}
                disabled={!form.isNew}
                onChange={(e) => updateForm("name", e.target.value)}
                placeholder="lowercase-kebab-case"
                className="w-full rounded-md border border-sh-brand-gray px-3 py-2 text-sh-black focus:border-sh-blue focus:outline-none disabled:bg-sh-stripe disabled:text-sh-gray"
              />
              {nameError && <p className="mt-1 text-xs text-red-600">{nameError}</p>}
              {!form.isNew && (
                <p className="mt-1 text-xs text-sh-gray">
                  Name is the definition&apos;s identity and can&apos;t be changed here — create a
                  new definition instead of renaming.
                </p>
              )}
            </div>

            <div>
              <label htmlFor="def-entity" className="mb-1 block text-sm text-sh-gray">
                Target entity
              </label>
              <input
                id="def-entity"
                type="text"
                list="import-entity-options"
                value={form.targetEntity}
                onChange={(e) => updateForm("targetEntity", e.target.value)}
                className="w-full rounded-md border border-sh-brand-gray px-3 py-2 text-sh-black focus:border-sh-blue focus:outline-none"
              />
              <datalist id="import-entity-options">
                {IMPORT_ENTITIES.map((e) => (
                  <option key={e.key} value={e.key}>
                    {e.label}
                  </option>
                ))}
              </datalist>
              <p className="mt-1 text-xs text-sh-gray">
                {entity
                  ? entity.description
                  : "Not a known entity yet — the definition saves but applies as inactive until it is registered."}
              </p>
            </div>

            <div>
              <label htmlFor="def-source-format" className="mb-1 block text-sm text-sh-gray">
                Source format
              </label>
              <select
                id="def-source-format"
                value={form.sourceFormat}
                onChange={(e) => updateForm("sourceFormat", e.target.value as DefinitionForm["sourceFormat"])}
                className="w-full rounded-md border border-sh-brand-gray px-3 py-2 text-sh-black focus:border-sh-blue focus:outline-none"
              >
                {importSourceFormatSchema.options.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="def-import-mode" className="mb-1 block text-sm text-sh-gray">
                Import mode
              </label>
              <select
                id="def-import-mode"
                value={form.importMode}
                onChange={(e) => updateForm("importMode", e.target.value as DefinitionForm["importMode"])}
                className="w-full rounded-md border border-sh-brand-gray px-3 py-2 text-sh-black focus:border-sh-blue focus:outline-none"
              >
                {importModeSchema.options.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="def-natural-keys" className="mb-1 block text-sm text-sh-gray">
                Natural key fields
              </label>
              <input
                id="def-natural-keys"
                type="text"
                value={form.naturalKeyFieldsText}
                onChange={(e) => updateForm("naturalKeyFieldsText", e.target.value)}
                placeholder="comma-separated, e.g. externalId"
                className="w-full rounded-md border border-sh-brand-gray px-3 py-2 text-sh-black focus:border-sh-blue focus:outline-none"
              />
              <p className="mt-1 text-xs text-sh-gray">Required when import mode is UPSERT.</p>
            </div>

            <div>
              <label htmlFor="def-runner-key" className="mb-1 block text-sm text-sh-gray">
                Runner key (advanced)
              </label>
              <input
                id="def-runner-key"
                type="text"
                value={form.runnerKey}
                onChange={(e) => updateForm("runnerKey", e.target.value)}
                placeholder="e.g. customer"
                className="w-full rounded-md border border-sh-brand-gray px-3 py-2 text-sh-black focus:border-sh-blue focus:outline-none"
              />
              <p className="mt-1 text-xs text-sh-gray">
                Names a registered runner (lib/imports/runnerRegistry.ts). Required when import mode
                is RECONCILE; an unregistered key fails on apply.
              </p>
            </div>

            <div className="md:col-span-2">
              <label htmlFor="def-description" className="mb-1 block text-sm text-sh-gray">
                Description
              </label>
              <textarea
                id="def-description"
                rows={2}
                value={form.description}
                onChange={(e) => updateForm("description", e.target.value)}
                className="w-full rounded-md border border-sh-brand-gray px-3 py-2 text-sh-black focus:border-sh-blue focus:outline-none"
              />
            </div>

            <label htmlFor="def-active" className="flex items-center gap-2 text-sm text-sh-black">
              <input
                id="def-active"
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => updateForm("isActive", e.target.checked)}
                className="h-4 w-4"
              />
              Active
            </label>
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-serif text-base text-sh-blue">Field mappings</h3>
              <Button variant="outline" size="sm" onClick={addFieldMapping}>
                <Plus className="mr-1 h-4 w-4" /> Add field mapping
              </Button>
            </div>
            <div className="space-y-2">
              {form.fieldMappings.map((fm, index) => (
                <div
                  key={index}
                  className="grid grid-cols-1 items-end gap-2 rounded-md border border-sh-brand-gray p-3 sm:grid-cols-[1fr_1fr_140px_auto_auto]"
                >
                  <div>
                    <label htmlFor={`fm-source-${index}`} className="mb-1 block text-xs text-sh-gray">
                      Source column
                    </label>
                    <input
                      id={`fm-source-${index}`}
                      type="text"
                      value={fm.sourceColumn}
                      onChange={(e) => updateFieldMapping(index, { sourceColumn: e.target.value })}
                      className="w-full rounded-md border border-sh-brand-gray px-2 py-1.5 text-sm text-sh-black focus:border-sh-blue focus:outline-none"
                    />
                  </div>
                  <div>
                    <label htmlFor={`fm-target-${index}`} className="mb-1 block text-xs text-sh-gray">
                      Target field
                    </label>
                    <input
                      id={`fm-target-${index}`}
                      type="text"
                      list="import-field-options"
                      value={fm.targetField}
                      onChange={(e) => updateFieldMapping(index, { targetField: e.target.value })}
                      className="w-full rounded-md border border-sh-brand-gray px-2 py-1.5 text-sm text-sh-black focus:border-sh-blue focus:outline-none"
                    />
                  </div>
                  <div>
                    <label htmlFor={`fm-transform-${index}`} className="mb-1 block text-xs text-sh-gray">
                      Transform
                    </label>
                    <select
                      id={`fm-transform-${index}`}
                      value={fm.transform}
                      onChange={(e) => updateFieldMapping(index, { transform: e.target.value as TransformValue })}
                      className="w-full rounded-md border border-sh-brand-gray px-2 py-1.5 text-sm text-sh-black focus:border-sh-blue focus:outline-none"
                    >
                      <option value="">(none)</option>
                      {importTransformSchema.options.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </div>
                  <label htmlFor={`fm-required-${index}`} className="flex items-center gap-1.5 pb-2 text-xs text-sh-black">
                    <input
                      id={`fm-required-${index}`}
                      type="checkbox"
                      checked={fm.required}
                      onChange={(e) => updateFieldMapping(index, { required: e.target.checked })}
                      className="h-4 w-4"
                    />
                    Required
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => removeFieldMapping(index)}
                    aria-label={`Remove field mapping ${fm.sourceColumn || index}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              {form.fieldMappings.length === 0 && (
                <p className="text-xs italic text-sh-gray">No field mappings yet.</p>
              )}
            </div>
            <datalist id="import-field-options">
              {entity?.fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </datalist>
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-serif text-base text-sh-blue">Value mappings</h3>
              <Button variant="outline" size="sm" onClick={() => addValueMapping("")}>
                <Plus className="mr-1 h-4 w-4" /> Add value mapping
              </Button>
            </div>
            <div className="space-y-4">
              {groupValueMappings(form.valueMappings).map((group) => (
                <div key={group.targetField} className="rounded-md border border-sh-brand-gray p-3">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-sh-gray">
                    {group.targetField}
                  </p>
                  <div className="space-y-2">
                    {group.indices.map((index) => {
                      const vm = form.valueMappings[index];
                      return (
                        <div key={index} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                          <div>
                            <label htmlFor={`vm-field-${index}`} className="mb-1 block text-xs text-sh-gray">
                              Target field
                            </label>
                            <input
                              id={`vm-field-${index}`}
                              type="text"
                              list="import-field-options"
                              value={vm.targetField}
                              onChange={(e) => updateValueMapping(index, { targetField: e.target.value })}
                              className="w-full rounded-md border border-sh-brand-gray px-2 py-1.5 text-sm text-sh-black focus:border-sh-blue focus:outline-none"
                            />
                          </div>
                          <div>
                            <label htmlFor={`vm-source-${index}`} className="mb-1 block text-xs text-sh-gray">
                              Source value
                            </label>
                            <input
                              id={`vm-source-${index}`}
                              type="text"
                              value={vm.sourceValue}
                              onChange={(e) => updateValueMapping(index, { sourceValue: e.target.value })}
                              className="w-full rounded-md border border-sh-brand-gray px-2 py-1.5 text-sm text-sh-black focus:border-sh-blue focus:outline-none"
                            />
                          </div>
                          <div>
                            <label htmlFor={`vm-target-${index}`} className="mb-1 block text-xs text-sh-gray">
                              Target value
                            </label>
                            <input
                              id={`vm-target-${index}`}
                              type="text"
                              value={vm.targetValue}
                              onChange={(e) => updateValueMapping(index, { targetValue: e.target.value })}
                              className="w-full rounded-md border border-sh-brand-gray px-2 py-1.5 text-sm text-sh-black focus:border-sh-blue focus:outline-none"
                            />
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => removeValueMapping(index)}
                            aria-label={`Remove value mapping ${vm.sourceValue || index}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              {form.valueMappings.length === 0 && (
                <p className="text-xs italic text-sh-gray">No value mappings yet.</p>
              )}
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
            <Button onClick={handlePreview} disabled={previewing || !form.name.trim()}>
              {previewing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Preview changes (dry run)
            </Button>
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
        </div>
      )}
    </div>
  );
}
