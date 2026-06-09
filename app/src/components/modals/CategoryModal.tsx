// /app/src/components/modals/CategoryModal.tsx

"use client";

import { useState, useEffect, useCallback } from "react";
import { Category } from "@prisma/client";
import FormInput from "@/components/form/FormInput";
import FormDropdown from "@/components/form/FormDropdown";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";
import { useFetchOptions } from "@/hooks/useFetchOptions";
import { toast } from "react-toastify";

type Props = {
  category: Category | null;
  onClose: () => void;
  onRefresh: () => void;
};

interface AccountGroupOption {
  id: number;
  name: string;
}

export default function CategoryModal({ category, onClose, onRefresh }: Props) {
  const [form, setForm] = useState({
    name: "",
    departmentId: "",
    trackInventory: true,
    accountGroupId: "",
    labelTemplateId: "",
  });

  const [saving, setSaving] = useState(false);
  const [accountGroups, setAccountGroups] = useState<AccountGroupOption[]>([]);

  // Use useFetchOptions for departments and label templates
  const [departments, loadingDepartments, errorDepartments] = useFetchOptions(
    "/api/departments?all=true",
  );
  const [templates, loadingTemplates, errorTemplates] = useFetchOptions("/api/labels?all=true");

  const fetchAccountGroups = useCallback(async () => {
    const res = await fetch("/api/accounting/account-groups");
    if (res.ok) setAccountGroups(await res.json());
  }, []);

  useEffect(() => {
    fetchAccountGroups();
  }, [fetchAccountGroups]);

  useEffect(() => {
    if (category) {
      setForm({
        name: category.name || "",
        departmentId: category.departmentId?.toString() || "",
        trackInventory: category.trackInventory ?? true,
        accountGroupId: (category as any).accountGroupId?.toString() || "",
        labelTemplateId: category.labelTemplateId?.toString() || "",
      });
    } else {
      setForm({
        name: "",
        departmentId: "",
        trackInventory: true,
        accountGroupId: "",
        labelTemplateId: "",
      });
    }
  }, [category]);

  const handleChange = (name: string, value: string) => {
    setForm({
      ...form,
      [name]: value,
    });
  };

  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, checked } = e.target;
    setForm({
      ...form,
      [name]: checked,
    });
  };

  const handleSubmit = async () => {
    setSaving(true);
    const method = category ? "PUT" : "POST";
    const url = category ? `/api/categories/${category.id}` : "/api/categories";

    const payload = {
      ...form,
      departmentId: Number.parseInt(form.departmentId),
      accountGroupId: form.accountGroupId ? Number.parseInt(form.accountGroupId) : null,
      labelTemplateId: form.labelTemplateId ? Number.parseInt(form.labelTemplateId) : null,
    };

    // Basic validation
    if (!payload.name || Number.isNaN(payload.departmentId)) {
      toast.error("Category Name and Department are required.");
      setSaving(false);
      return;
    }

    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        toast.success(`Category ${category ? "updated" : "added"} successfully.`);
        onRefresh();
        onClose();
      } else {
        const errorData = await res.json();
        toast.error(
          `Failed to save category: ${errorData.error || errorData.message || "Unknown error"}`,
        );
      }
    } catch {
      toast.error("Error occurred while saving category.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={category ? "Edit Category" : "Add Category"}
      onClose={onClose}
      onSave={handleSubmit}
      saving={saving}
    >
      <FormInput
        label="Name"
        name="name"
        value={form.name}
        onChange={(v) => handleChange("name", v)} // CORRECTED: Wrap to pass only value
        required
      />

      <label className="block mb-2 text-sm text-sh-blue">Department</label>
      {loadingDepartments ? (
        <p className="text-sh-black">Loading departments...</p>
      ) : errorDepartments ? (
        <p className="text-red-600">Error loading departments: {errorDepartments.message}</p>
      ) : (
        <select
          name="departmentId"
          value={form.departmentId}
          onChange={(e) => handleChange("departmentId", e.target.value)}
          className="w-full border border-sh-gray rounded-lg px-3 py-2 mb-4 font-serif text-sh-black"
          required
        >
          <option value="">Select Department...</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      )}

      <label className="block mb-2 text-sm text-sh-blue">Track Inventory</label>
      <input
        type="checkbox"
        name="trackInventory"
        checked={form.trackInventory}
        onChange={handleCheckboxChange}
        className="mb-4 h-5 w-5 border border-sh-gray rounded accent-sh-blue"
      />

      <FormDropdown
        label="Account Group"
        options={accountGroups.map((g) => ({ id: String(g.id), name: g.name }))}
        value={form.accountGroupId}
        onChange={(v) => handleChange("accountGroupId", v)}
      />

      <label className="block mb-2 text-sm text-sh-blue">Label Template</label>
      {loadingTemplates ? (
        <p className="text-sh-black">Loading templates...</p>
      ) : errorTemplates ? (
        <p className="text-red-600">Error loading templates: {errorTemplates.message}</p>
      ) : (
        <select
          name="labelTemplateId"
          value={form.labelTemplateId}
          onChange={(e) => handleChange("labelTemplateId", e.target.value)}
          className="w-full border border-sh-gray rounded-lg px-3 py-2 mb-4 font-serif text-sh-black"
        >
          <option value="">None</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}

      <div className="flex justify-end gap-4 mt-4">
        {category?.id && (
          <Button
            variant="secondary"
            onClick={async () => {
              const confirmed = confirm(
                `Are you sure you want to delete category "${category.name}"? This action cannot be undone.`,
              );
              if (!confirmed) return;
              setSaving(true);
              try {
                const res = await fetch(`/api/categories/${category.id}`, { method: "DELETE" });
                if (res.ok) {
                  toast.success(`Category "${category.name}" deleted successfully.`);
                  onRefresh();
                  onClose();
                } else {
                  const errorData = await res.json();
                  toast.error(
                    `Failed to delete category: ${errorData.error || errorData.message || "Unknown error"}`,
                  );
                }
              } catch {
                toast.error("Error occurred while deleting category.");
              } finally {
                setSaving(false);
              }
            }}
            disabled={saving}
          >
            Delete
          </Button>
        )}
      </div>
    </Modal>
  );
}
