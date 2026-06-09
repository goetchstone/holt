// /app/src/components/modals/AccountGroupModal.tsx

import { useState, useEffect } from "react";
import FormInput from "@/components/form/FormInput";
import FormDropdown from "@/components/form/FormDropdown";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";

interface GLAccountOption {
  id: number;
  code: string;
  name: string;
}

interface AccountGroup {
  id: number;
  name: string;
  description: string | null;
  cogsAccountId: number | null;
  inventoryAccountId: number | null;
  salesAccountId: number | null;
  returnsAccountId: number | null;
  transfersAccountId: number | null;
  shrinkageAccountId: number | null;
}

type Props = {
  item: AccountGroup | null;
  glAccounts: GLAccountOption[];
  onClose: () => void;
  onRefresh: () => void;
};

export default function AccountGroupModal({ item, glAccounts, onClose, onRefresh }: Props) {
  const [form, setForm] = useState({
    name: "",
    description: "",
    cogsAccountId: "",
    inventoryAccountId: "",
    salesAccountId: "",
    returnsAccountId: "",
    transfersAccountId: "",
    shrinkageAccountId: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (item) {
      setForm({
        name: item.name,
        description: item.description || "",
        cogsAccountId: item.cogsAccountId ? String(item.cogsAccountId) : "",
        inventoryAccountId: item.inventoryAccountId ? String(item.inventoryAccountId) : "",
        salesAccountId: item.salesAccountId ? String(item.salesAccountId) : "",
        returnsAccountId: item.returnsAccountId ? String(item.returnsAccountId) : "",
        transfersAccountId: item.transfersAccountId ? String(item.transfersAccountId) : "",
        shrinkageAccountId: item.shrinkageAccountId ? String(item.shrinkageAccountId) : "",
      });
    } else {
      setForm({
        name: "",
        description: "",
        cogsAccountId: "",
        inventoryAccountId: "",
        salesAccountId: "",
        returnsAccountId: "",
        transfersAccountId: "",
        shrinkageAccountId: "",
      });
    }
  }, [item]);

  const accountOptions = glAccounts.map((a) => ({
    id: String(a.id),
    name: `${a.code} - ${a.name}`,
  }));

  const handleSubmit = async () => {
    setSaving(true);
    const method = item ? "PUT" : "POST";
    const url = item
      ? `/api/accounting/account-groups/${item.id}`
      : "/api/accounting/account-groups";

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
    if (!confirm("Delete this account group? This cannot be undone.")) return;

    setSaving(true);
    try {
      const res = await fetch(`/api/accounting/account-groups/${item.id}`, { method: "DELETE" });
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
      title={item ? "Edit Account Group" : "Add Account Group"}
      onClose={onClose}
      onSave={handleSubmit}
      saving={saving}
    >
      <FormInput
        label="Name"
        name="name"
        value={form.name}
        onChange={(v) => setForm({ ...form, name: v })}
        required
        placeholder="Furniture Sales"
      />

      <FormInput
        label="Description"
        name="description"
        value={form.description}
        onChange={(v) => setForm({ ...form, description: v })}
        placeholder="Optional"
      />

      <div className="grid grid-cols-2 gap-4">
        <FormDropdown
          label="COGS Account"
          options={accountOptions}
          value={form.cogsAccountId}
          onChange={(v) => setForm({ ...form, cogsAccountId: v })}
        />
        <FormDropdown
          label="Inventory Account"
          options={accountOptions}
          value={form.inventoryAccountId}
          onChange={(v) => setForm({ ...form, inventoryAccountId: v })}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <FormDropdown
          label="Sales Account"
          options={accountOptions}
          value={form.salesAccountId}
          onChange={(v) => setForm({ ...form, salesAccountId: v })}
        />
        <FormDropdown
          label="Returns Account"
          options={accountOptions}
          value={form.returnsAccountId}
          onChange={(v) => setForm({ ...form, returnsAccountId: v })}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <FormDropdown
          label="Transfers Account"
          options={accountOptions}
          value={form.transfersAccountId}
          onChange={(v) => setForm({ ...form, transfersAccountId: v })}
        />
        <FormDropdown
          label="Shrinkage Account"
          options={accountOptions}
          value={form.shrinkageAccountId}
          onChange={(v) => setForm({ ...form, shrinkageAccountId: v })}
        />
      </div>

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
