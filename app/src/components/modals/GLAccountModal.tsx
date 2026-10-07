// /app/src/components/modals/GLAccountModal.tsx

import { useState, useEffect, ChangeEvent } from "react";
import FormInput from "@/components/form/FormInput";
import FormDropdown from "@/components/form/FormDropdown";
import FormCheckbox from "@/components/form/FormCheckbox";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";

interface GLAccount {
  id: number;
  code: string;
  name: string;
  accountType: string;
  isActive: boolean;
}

type Props = {
  item: GLAccount | null;
  onClose: () => void;
  onRefresh: () => void;
};

const ACCOUNT_TYPES = [
  { id: "ASSET", name: "Asset" },
  { id: "LIABILITY", name: "Liability" },
  { id: "EQUITY", name: "Equity" },
  { id: "REVENUE", name: "Revenue" },
  { id: "EXPENSE", name: "Expense" },
];

export default function GLAccountModal({ item, onClose, onRefresh }: Props) {
  const [form, setForm] = useState({
    code: "",
    name: "",
    accountType: "",
    isActive: true,
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (item) {
      setForm({
        code: item.code,
        name: item.name,
        accountType: item.accountType,
        isActive: item.isActive,
      });
    } else {
      setForm({ code: "", name: "", accountType: "", isActive: true });
    }
  }, [item]);

  const handleSubmit = async () => {
    setSaving(true);
    const method = item ? "PUT" : "POST";
    const url = item ? `/api/accounting/gl-accounts/${item.id}` : "/api/accounting/gl-accounts";

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
    if (!confirm("Delete this GL account? This cannot be undone.")) return;

    setSaving(true);
    try {
      const res = await fetch(`/api/accounting/gl-accounts/${item.id}`, { method: "DELETE" });
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
      title={item ? "Edit GL Account" : "Add GL Account"}
      onClose={onClose}
      onSave={handleSubmit}
      saving={saving}
    >
      <div className="grid grid-cols-2 gap-4">
        <FormInput
          label="Account Code"
          name="code"
          value={form.code}
          onChange={(v) => setForm({ ...form, code: v })}
          required
          placeholder="1000"
        />
        <FormDropdown
          label="Account Type"
          options={ACCOUNT_TYPES}
          value={form.accountType}
          onChange={(v) => setForm({ ...form, accountType: v })}
        />
      </div>

      <FormInput
        label="Name"
        name="name"
        value={form.name}
        onChange={(v) => setForm({ ...form, name: v })}
        required
        placeholder="Cash"
      />

      {item && (
        <FormCheckbox
          label="Active"
          name="isActive"
          checked={form.isActive}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            setForm({ ...form, isActive: e.target.checked })
          }
        />
      )}

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
