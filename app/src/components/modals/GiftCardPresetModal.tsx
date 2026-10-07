// /app/src/components/modals/GiftCardPresetModal.tsx

import { useState, useEffect, ChangeEvent } from "react";
import FormInput from "@/components/form/FormInput";
import FormCheckbox from "@/components/form/FormCheckbox";
import Modal from "@/components/ui/Modal";

interface GiftCardPreset {
  id: number;
  code: string;
  amount: number | null;
  label: string;
  isActive: boolean;
  sortOrder: number;
}

type Props = {
  item: GiftCardPreset | null;
  onClose: () => void;
  onRefresh: () => void;
};

export default function GiftCardPresetModal({ item, onClose, onRefresh }: Props) {
  const [form, setForm] = useState({
    code: "",
    label: "",
    amount: "",
    isCustomAmount: true,
    isActive: true,
    sortOrder: "0",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (item) {
      setForm({
        code: item.code,
        label: item.label,
        amount: item.amount !== null ? String(item.amount) : "",
        isCustomAmount: item.amount === null,
        isActive: item.isActive,
        sortOrder: String(item.sortOrder),
      });
    } else {
      setForm({
        code: "",
        label: "",
        amount: "",
        isCustomAmount: false,
        isActive: true,
        sortOrder: "0",
      });
    }
  }, [item]);

  const handleSubmit = async () => {
    setSaving(true);
    const method = item ? "PUT" : "POST";
    const url = item ? `/api/gift-cards/presets/${item.id}` : "/api/gift-cards/presets";

    const body = {
      code: form.code,
      label: form.label,
      amount: form.isCustomAmount ? null : Number.parseFloat(form.amount) || 0,
      isActive: form.isActive,
      sortOrder: Number.parseInt(form.sortOrder, 10) || 0,
    };

    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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

  return (
    <Modal
      title={item ? "Edit Preset" : "Add Preset"}
      onClose={onClose}
      onSave={handleSubmit}
      saving={saving}
    >
      <div className="grid grid-cols-2 gap-4">
        <FormInput
          label="Quick Code"
          name="code"
          value={form.code}
          onChange={(v) => setForm({ ...form, code: v })}
          required
          placeholder="GC50"
        />
        <FormInput
          label="Sort Order"
          name="sortOrder"
          value={form.sortOrder}
          onChange={(v) => setForm({ ...form, sortOrder: v })}
          type="number"
        />
      </div>

      <FormInput
        label="Display Label"
        name="label"
        value={form.label}
        onChange={(v) => setForm({ ...form, label: v })}
        required
        placeholder="$50 Gift Card"
      />

      <FormCheckbox
        label="Prompt for custom amount"
        name="isCustomAmount"
        checked={form.isCustomAmount}
        onChange={(e: ChangeEvent<HTMLInputElement>) =>
          setForm({ ...form, isCustomAmount: e.target.checked, amount: "" })
        }
      />

      {!form.isCustomAmount && (
        <FormInput
          label="Preset Amount"
          name="amount"
          value={form.amount}
          onChange={(v) => setForm({ ...form, amount: v })}
          type="number"
          placeholder="50.00"
        />
      )}

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
    </Modal>
  );
}
