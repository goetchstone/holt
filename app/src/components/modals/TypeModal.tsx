// /app/src/components/modals/TypeModal.tsx

import { useState, useEffect } from "react";
import { Type } from "@prisma/client";
import { toast } from "react-toastify";
import FormInput from "@/components/form/FormInput";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";
import { getErrorMessage } from "@/lib/toastError";

type Props = {
  type: Type | null;
  onClose: () => void;
  onRefresh: () => void;
};

export default function TypeModal({ type, onClose, onRefresh }: Props) {
  const [form, setForm] = useState({
    name: "",
    categoryId: "",
  });
  const [saving, setSaving] = useState(false);
  const [categories, setCategories] = useState<{ id: number; name: string }[]>([]);

  useEffect(() => {
    if (type) {
      setForm({
        name: type.name || "",
        categoryId: type.categoryId?.toString() || "",
      });
    } else {
      setForm({
        name: "",
        categoryId: "",
      });
    }

    // Modified: Fetch all categories by adding ?all=true query parameter
    fetch("/api/categories?all=true")
      .then((res) => res.json())
      .then((data) => setCategories(data.categories || []))
      .catch((error) => {
        toast.error(getErrorMessage(error, "Failed to load categories."));
        setCategories([]);
      });
  }, [type]);

  const handleChange = (name: string, value: string) => {
    setForm({
      ...form,
      [name]: value,
    });
  };

  const handleSubmit = async () => {
    setSaving(true);
    const method = type ? "PUT" : "POST";
    const url = type ? `/api/types/${type.id}` : "/api/types";

    const payload = {
      ...form,
      categoryId: Number.parseInt(form.categoryId),
    };

    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        onRefresh();
        onClose();
      } else {
        const errorData = await res.json();
        alert(`Failed to save type: ${errorData.error || errorData.message || "Unknown error"}`);
      }
    } catch {
      alert("Error occurred while saving.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!type || !type.id) return;

    const confirmed = confirm(
      "Are you sure you want to delete this type? This action cannot be undone.",
    );
    if (!confirmed) return;

    setSaving(true);
    try {
      const res = await fetch(`/api/types/${type.id}`, {
        method: "DELETE",
      });

      if (res.ok) {
        onRefresh();
        onClose();
      } else {
        const errorData = await res.json();
        alert(`Failed to delete type: ${errorData.error || errorData.message || "Unknown error"}`);
      }
    } catch {
      alert("Error occurred while deleting.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={type ? "Edit Type" : "Add Type"}
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

      <label className="block mb-2 text-sm text-sh-blue">Category</label>
      <select
        name="categoryId"
        value={form.categoryId}
        onChange={(e) => handleChange("categoryId", e.target.value)}
        className="w-full border border-sh-gray rounded-lg px-3 py-2 mb-4 font-serif text-sh-black"
        required
      >
        <option value="">Select Category...</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>

      <div className="flex justify-end gap-4 mt-4">
        {type && (
          <Button variant="secondary" onClick={handleDelete} disabled={saving}>
            Delete
          </Button>
        )}
      </div>
    </Modal>
  );
}
