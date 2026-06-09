// /app/src/components/modals/LabelTemplateModal.tsx

import { useState, useEffect } from "react";
import { LabelTemplate } from "@prisma/client";
import FormInput from "@/components/form/FormInput";
import FormTextArea from "@/components/form/FormTextArea"; // Assuming you might use this for ZPL
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";

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
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (template) {
      setForm({
        name: template.name || "",
        context: template.context || "",
        tagSize: template.tagSize || "",
        zplTemplate: template.zplTemplate || "",
      });
    } else {
      setForm({
        name: "",
        context: "",
        tagSize: "",
        zplTemplate: "",
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
    const method = template ? "PUT" : "POST";
    // Use the /api/templates/[id] for PUT, and /api/labels for POST
    const url = template ? `/api/templates/${template.id}` : "/api/labels";

    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
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
      title={template ? "Edit Label Template" : "Add Label Template"}
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
      <FormInput
        label="Context"
        name="context"
        value={form.context}
        onChange={(v) => handleChange("context", v)}
        required
      />
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

      <div className="flex justify-end gap-4 mt-4">
        {template && ( // Only show delete button for existing templates
          <Button variant="secondary" onClick={handleDelete} disabled={saving}>
            Delete
          </Button>
        )}
      </div>
    </Modal>
  );
}
