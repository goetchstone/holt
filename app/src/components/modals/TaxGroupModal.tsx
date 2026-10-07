// /app/src/components/modals/TaxGroupModal.tsx

import { useState, useEffect, ChangeEvent } from "react";
import FormInput from "@/components/form/FormInput";
import FormDropdown from "@/components/form/FormDropdown";
import FormCheckbox from "@/components/form/FormCheckbox";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";

interface TaxGroup {
  id: number;
  name: string;
  taxBasis: string;
  freightTaxable: boolean;
  miscTaxable: boolean;
}

type Props = {
  item: TaxGroup | null;
  onClose: () => void;
  onRefresh: () => void;
};

const TAX_BASIS_OPTIONS = [
  { id: "NET", name: "Net" },
  { id: "GROSS", name: "Gross" },
];

export default function TaxGroupModal({ item, onClose, onRefresh }: Props) {
  const [form, setForm] = useState({
    name: "",
    taxBasis: "NET",
    freightTaxable: false,
    miscTaxable: false,
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (item) {
      setForm({
        name: item.name,
        taxBasis: item.taxBasis || "NET",
        freightTaxable: item.freightTaxable,
        miscTaxable: item.miscTaxable,
      });
    } else {
      setForm({ name: "", taxBasis: "NET", freightTaxable: false, miscTaxable: false });
    }
  }, [item]);

  const handleSubmit = async () => {
    setSaving(true);
    const method = item ? "PUT" : "POST";
    const url = item ? `/api/tax/groups/${item.id}` : "/api/tax/groups";

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
    if (!confirm(`Delete tax group "${item.name}"? This cannot be undone.`)) return;

    setSaving(true);
    try {
      const res = await fetch(`/api/tax/groups/${item.id}`, { method: "DELETE" });
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
      title={item ? "Edit Tax Group" : "Add Tax Group"}
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
      />
      <FormDropdown
        label="Tax Basis"
        options={TAX_BASIS_OPTIONS}
        value={form.taxBasis}
        onChange={(v) => setForm({ ...form, taxBasis: v })}
      />
      <FormCheckbox
        label="Freight Taxable"
        name="freightTaxable"
        checked={form.freightTaxable}
        onChange={(e: ChangeEvent<HTMLInputElement>) =>
          setForm({ ...form, freightTaxable: e.target.checked })
        }
      />
      <FormCheckbox
        label="Miscellaneous Taxable"
        name="miscTaxable"
        checked={form.miscTaxable}
        onChange={(e: ChangeEvent<HTMLInputElement>) =>
          setForm({ ...form, miscTaxable: e.target.checked })
        }
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
