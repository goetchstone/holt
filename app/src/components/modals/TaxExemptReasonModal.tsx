// /app/src/components/modals/TaxExemptReasonModal.tsx

import { useState, useEffect } from "react";
import FormInput from "@/components/form/FormInput";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";

interface TaxExemptReason {
  id: number;
  name: string;
  description: string | null;
}

type Props = {
  item: TaxExemptReason | null;
  onClose: () => void;
  onRefresh: () => void;
};

export default function TaxExemptReasonModal({ item, onClose, onRefresh }: Props) {
  const [form, setForm] = useState({ name: "", description: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (item) {
      setForm({ name: item.name, description: item.description || "" });
    } else {
      setForm({ name: "", description: "" });
    }
  }, [item]);

  const handleChange = (name: string, value: string) => {
    setForm({ ...form, [name]: value });
  };

  const handleSubmit = async () => {
    setSaving(true);
    const method = item ? "PUT" : "POST";
    const url = item ? `/api/tax/exempt-reasons/${item.id}` : "/api/tax/exempt-reasons";

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
        const data = await res.json();
        alert(data.error || "Failed to save");
      }
    } catch {
      alert("Error occurred while saving.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!item) return;
    if (!confirm(`Delete exempt reason "${item.name}"? This cannot be undone.`)) return;

    setSaving(true);
    try {
      const res = await fetch(`/api/tax/exempt-reasons/${item.id}`, { method: "DELETE" });
      if (res.ok) {
        onRefresh();
        onClose();
      } else {
        const data = await res.json();
        alert(data.error || "Failed to delete");
      }
    } catch {
      alert("Error occurred while deleting.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={item ? "Edit Exempt Reason" : "Add Exempt Reason"}
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
        label="Description"
        name="description"
        value={form.description}
        onChange={(v) => handleChange("description", v)}
      />

      {item && (
        <div className="flex justify-end mt-4">
          <Button variant="secondary" onClick={handleDelete} disabled={saving}>
            Delete
          </Button>
        </div>
      )}
    </Modal>
  );
}
