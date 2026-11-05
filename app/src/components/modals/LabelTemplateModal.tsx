// /app/src/components/modals/LabelTemplateModal.tsx

import { useState, useEffect } from "react";
import { LabelTemplate } from "@prisma/client";
import FormInput from "@/components/form/FormInput";
import FormTextArea from "@/components/form/FormTextArea"; // Assuming you might use this for ZPL
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";
import {
  isLabelContext,
  LABEL_CONTEXT_NAMES,
  LABEL_FIELDS,
  type LabelContext,
} from "@/lib/labels/renderTemplate";
import { isSavedRecord } from "@/lib/savedRecord";

const CONTEXTS = Object.keys(LABEL_FIELDS) as LabelContext[];

type Props = {
  template: LabelTemplate | null; // Can be null for new template
  onClose: () => void;
  onRefresh: () => void; // Callback to refresh parent list
};

export default function LabelTemplateModal({ template, onClose, onRefresh }: Props) {
  const [form, setForm] = useState({
    name: "",
    context: "",
    tagSize: "",
    zplTemplate: "", // ZPL template string
    photoDots: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (template) {
      setForm({
        name: template.name || "",
        context: template.context || "",
        tagSize: template.tagSize || "",
        zplTemplate: template.zplTemplate || "",
        photoDots: template.photoDots?.toString() || "",
      });
    } else {
      setForm({
        name: "",
        context: "",
        tagSize: "",
        zplTemplate: "",
        photoDots: "",
      });
    }
  }, [template]);

  const handleChange = (name: string, value: string) => {
    setForm({
      ...form,
      [name]: value,
    });
  };

  const handleSubmit = async () => {
    setSaving(true);
    const editing = isSavedRecord(template);
    const method = editing ? "PUT" : "POST";
    // Use the /api/templates/[id] for PUT, and /api/labels for POST
    const url = editing ? `/api/templates/${template.id}` : "/api/labels";

    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          photoDots: form.photoDots ? Number(form.photoDots) : null,
        }),
      });

      if (res.ok) {
        onRefresh();
        onClose();
      } else {
        const errorData = await res.json();
        alert(
          `Failed to save label template: ${errorData.error || errorData.message || "Unknown error"}`,
        );
      }
    } catch {
      alert("Error occurred while saving.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!template || !template.id) return;

    const confirmed = confirm(
      `Are you sure you want to delete label template "${template.name}"? This action cannot be undone.`,
    );
    if (!confirmed) return;

    setSaving(true);
    try {
      const res = await fetch(`/api/templates/${template.id}`, {
        // Use /api/templates/[id] for DELETE
        method: "DELETE",
      });

      if (res.ok) {
        onRefresh();
        onClose();
      } else {
        const errorData = await res.json();
        alert(
          `Failed to delete label template: ${errorData.error || errorData.message || "Unknown error"}`,
        );
      }
    } catch {
      alert("Error occurred while deleting.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={isSavedRecord(template) ? "Edit Label Template" : "Add Label Template"}
      onClose={onClose}
      onSave={handleSubmit}
      saving={saving}
    >
      <FormInput
        label="Name"
        name="name"
        value={form.name}
        onChange={(v) => handleChange("name", v)}
        required
      />
      <div>
        <label htmlFor="label-context" className="block text-sm text-brand-gray mb-1">
          Kind of label
        </label>
        <select
          id="label-context"
          value={form.context}
          onChange={(e) => handleChange("context", e.target.value)}
          className="w-full border border-brand-gray/30 rounded px-3 py-2 text-sm"
        >
          <option value="">Choose...</option>
          {CONTEXTS.map((c) => (
            <option key={c} value={c}>
              {LABEL_CONTEXT_NAMES[c]}
            </option>
          ))}
          {form.context && !isLabelContext(form.context) && (
            <option value={form.context}>{form.context} (nothing prints this)</option>
          )}
        </select>
      </div>
      <FormInput
        label="Tag Size"
        name="tagSize"
        value={form.tagSize}
        onChange={(v) => handleChange("tagSize", v)}
        required
      />
      {/* Assuming ZPL template can be a multi-line text area */}
      <FormTextArea
        label="ZPL Template"
        name="zplTemplate"
        value={form.zplTemplate}
        onChange={(v) => handleChange("zplTemplate", v)}
        rows={8}
        required
      />
      {isLabelContext(form.context) && (
        <p className="text-xs text-brand-gray">
          This label can use: {LABEL_FIELDS[form.context].map((f) => `{{${f}}}`).join(", ")}.
          {(LABEL_FIELDS[form.context] as readonly string[]).includes("baseCost") &&
            " baseCost prints the real cost. On a tag a customer can read, use costCode."}
        </p>
      )}
      {(form.context === "PRODUCT" || form.context === "SALE") && (
        <FormInput
          label="Photo size (dots along its longest side; empty for no photo)"
          name="photoDots"
          type="number"
          value={form.photoDots}
          onChange={(v) => handleChange("photoDots", v)}
        />
      )}

      <div className="flex justify-end gap-4 mt-4">
        {isSavedRecord(template) && ( // Only show delete button for existing templates
          <Button variant="secondary" onClick={handleDelete} disabled={saving}>
            Delete
          </Button>
        )}
      </div>
    </Modal>
  );
}
