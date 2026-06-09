// /app/src/components/modals/TaxRuleModal.tsx

import { useState, useEffect, ChangeEvent } from "react";
import FormInput from "@/components/form/FormInput";
import FormDropdown from "@/components/form/FormDropdown";
import FormCheckbox from "@/components/form/FormCheckbox";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";

interface District {
  id: number;
  shortName: string;
  name: string;
}

interface Group {
  id: number;
  name: string;
}

interface TaxRule {
  id: number;
  districtId: number;
  groupId: number;
  taxRate: number;
  triggerPrice: number | null;
  startPrice: number | null;
  stopPrice: number | null;
  triggerStop: number | null;
  taxIncludedInSalesPrice: boolean;
  ruleToAddBeforeCalcId: number | null;
  sortOrder: number;
  isActive: boolean;
}

type Props = {
  item: TaxRule | null;
  districts: District[];
  groups: Group[];
  rules: TaxRule[];
  onClose: () => void;
  onRefresh: () => void;
};

export default function TaxRuleModal({
  item,
  districts,
  groups,
  rules,
  onClose,
  onRefresh,
}: Props) {
  const [form, setForm] = useState({
    districtId: "",
    groupId: "",
    taxRate: "",
    triggerPrice: "",
    startPrice: "",
    stopPrice: "",
    triggerStop: "",
    taxIncludedInSalesPrice: false,
    ruleToAddBeforeCalcId: "",
    sortOrder: "0",
    isActive: true,
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (item) {
      setForm({
        districtId: String(item.districtId),
        groupId: String(item.groupId),
        taxRate: String(item.taxRate * 100),
        triggerPrice: item.triggerPrice != null ? String(item.triggerPrice) : "",
        startPrice: item.startPrice != null ? String(item.startPrice) : "",
        stopPrice: item.stopPrice != null ? String(item.stopPrice) : "",
        triggerStop: item.triggerStop != null ? String(item.triggerStop) : "",
        taxIncludedInSalesPrice: item.taxIncludedInSalesPrice,
        ruleToAddBeforeCalcId: item.ruleToAddBeforeCalcId ? String(item.ruleToAddBeforeCalcId) : "",
        sortOrder: String(item.sortOrder),
        isActive: item.isActive,
      });
    } else {
      setForm({
        districtId: "",
        groupId: "",
        taxRate: "",
        triggerPrice: "",
        startPrice: "",
        stopPrice: "",
        triggerStop: "",
        taxIncludedInSalesPrice: false,
        ruleToAddBeforeCalcId: "",
        sortOrder: "0",
        isActive: true,
      });
    }
  }, [item]);

  // Chain dropdown: only rules matching same district+group, excluding self
  const chainOptions = rules
    .filter(
      (r) =>
        String(r.districtId) === form.districtId &&
        String(r.groupId) === form.groupId &&
        (!item || r.id !== item.id),
    )
    .map((r) => ({
      id: String(r.id),
      name: `Rule #${r.id} (${(r.taxRate * 100).toFixed(2)}%, order ${r.sortOrder})`,
    }));

  const handleSubmit = async () => {
    setSaving(true);
    const method = item ? "PUT" : "POST";
    const url = item ? `/api/tax/rules/${item.id}` : "/api/tax/rules";

    const body = {
      districtId: form.districtId,
      groupId: form.groupId,
      taxRate: Number.parseFloat(form.taxRate) / 100,
      triggerPrice: form.triggerPrice ? Number.parseFloat(form.triggerPrice) : null,
      startPrice: form.startPrice ? Number.parseFloat(form.startPrice) : null,
      stopPrice: form.stopPrice ? Number.parseFloat(form.stopPrice) : null,
      triggerStop: form.triggerStop ? Number.parseFloat(form.triggerStop) : null,
      taxIncludedInSalesPrice: form.taxIncludedInSalesPrice,
      ruleToAddBeforeCalcId: form.ruleToAddBeforeCalcId || null,
      sortOrder: form.sortOrder,
      isActive: form.isActive,
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

  const handleDelete = async () => {
    if (!item) return;
    if (!confirm("Delete this tax rule? This cannot be undone.")) return;

    setSaving(true);
    try {
      const res = await fetch(`/api/tax/rules/${item.id}`, { method: "DELETE" });
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

  const districtOptions = districts.map((d) => ({
    id: String(d.id),
    name: `${d.shortName} - ${d.name}`,
  }));

  const groupOptions = groups.map((g) => ({
    id: String(g.id),
    name: g.name,
  }));

  return (
    <Modal
      title={item ? "Edit Tax Rule" : "Add Tax Rule"}
      onClose={onClose}
      onSave={handleSubmit}
      saving={saving}
    >
      <div className="grid grid-cols-2 gap-4">
        <FormDropdown
          label="District"
          options={districtOptions}
          value={form.districtId}
          onChange={(v) => setForm({ ...form, districtId: v })}
        />
        <FormDropdown
          label="Tax Group"
          options={groupOptions}
          value={form.groupId}
          onChange={(v) => setForm({ ...form, groupId: v })}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <FormInput
          label="Tax Rate (%)"
          name="taxRate"
          type="number"
          value={form.taxRate}
          onChange={(v) => setForm({ ...form, taxRate: v })}
          required
          placeholder="6.35"
        />
        <FormInput
          label="Sort Order"
          name="sortOrder"
          type="number"
          value={form.sortOrder}
          onChange={(v) => setForm({ ...form, sortOrder: v })}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <FormInput
          label="Trigger Price"
          name="triggerPrice"
          type="number"
          value={form.triggerPrice}
          onChange={(v) => setForm({ ...form, triggerPrice: v })}
          placeholder="Optional"
        />
        <FormInput
          label="Trigger Stop"
          name="triggerStop"
          type="number"
          value={form.triggerStop}
          onChange={(v) => setForm({ ...form, triggerStop: v })}
          placeholder="Optional"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <FormInput
          label="Start Price"
          name="startPrice"
          type="number"
          value={form.startPrice}
          onChange={(v) => setForm({ ...form, startPrice: v })}
          placeholder="Optional"
        />
        <FormInput
          label="Stop Price"
          name="stopPrice"
          type="number"
          value={form.stopPrice}
          onChange={(v) => setForm({ ...form, stopPrice: v })}
          placeholder="Optional"
        />
      </div>

      <FormCheckbox
        label="Tax Included in Sales Price"
        name="taxIncludedInSalesPrice"
        checked={form.taxIncludedInSalesPrice}
        onChange={(e: ChangeEvent<HTMLInputElement>) =>
          setForm({ ...form, taxIncludedInSalesPrice: e.target.checked })
        }
      />

      {chainOptions.length > 0 && (
        <FormDropdown
          label="Rule to Add Before Calc"
          options={chainOptions}
          value={form.ruleToAddBeforeCalcId}
          onChange={(v) => setForm({ ...form, ruleToAddBeforeCalcId: v })}
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
