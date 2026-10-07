// /app/src/components/modals/DepartmentModal.tsx

import { useState, useEffect } from "react";
import { Department } from "@prisma/client";
import FormInput from "@/components/form/FormInput";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";

type Props = {
  department: Department | null; // Can be null for new department
  onClose: () => void;
  onRefresh: () => void; // Callback to refresh parent list
};

export default function DepartmentModal({ department, onClose, onRefresh }: Props) {
  const [form, setForm] = useState({
    name: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (department) {
      setForm({
        name: department.name || "",
      });
    } else {
      setForm({
        name: "",
      });
    }
  }, [department]);

  const handleChange = (name: string, value: string) => {
    setForm({
      ...form,
      [name]: value,
    });
  };

  const handleSubmit = async () => {
    setSaving(true);
    const method = department ? "PUT" : "POST";
    const url = department ? `/api/departments/${department.id}` : "/api/departments";

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
          `Failed to save department: ${errorData.error || errorData.message || "Unknown error"}`,
        );
      }
    } catch {
      alert("Error occurred while saving.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!department || !department.id) return;

    const confirmed = confirm(
      `Are you sure you want to delete department "${department.name}"? This action cannot be undone.`,
    );
    if (!confirmed) return;

    setSaving(true);
    try {
      const res = await fetch(`/api/departments/${department.id}`, {
        method: "DELETE",
      });

      if (res.ok) {
        onRefresh();
        onClose();
      } else {
        const errorData = await res.json();
        alert(
          `Failed to delete department: ${errorData.error || errorData.message || "Unknown error"}`,
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
      title={department ? "Edit Department" : "Add Department"}
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

      <div className="flex justify-end gap-4 mt-4">
        {department && ( // Only show delete button for existing departments
          <Button variant="secondary" onClick={handleDelete} disabled={saving}>
            Delete
          </Button>
        )}
      </div>
    </Modal>
  );
}
