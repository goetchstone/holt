// /app/src/components/modals/TaxDistrictModal.tsx

import { useState, useEffect, useCallback, ChangeEvent } from "react";
import FormInput from "@/components/form/FormInput";
import FormDropdown from "@/components/form/FormDropdown";
import FormCheckbox from "@/components/form/FormCheckbox";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";
import { X } from "lucide-react";

interface TaxDistrictZipCode {
  id: number;
  zipCode: string;
}

interface TaxDistrict {
  id: number;
  shortName: string;
  state: string;
  authority: string | null;
  name: string;
  reference: string | null;
  glAccountId: number | null;
  isActive: boolean;
  zipCodes?: TaxDistrictZipCode[];
}

interface GLAccountOption {
  id: number;
  code: string;
  name: string;
}

type Props = {
  item: TaxDistrict | null;
  onClose: () => void;
  onRefresh: () => void;
};

export default function TaxDistrictModal({ item, onClose, onRefresh }: Props) {
  const [form, setForm] = useState({
    shortName: "",
    state: "",
    authority: "",
    name: "",
    reference: "",
    glAccountId: "",
    isActive: true,
  });
  const [zipCodes, setZipCodes] = useState<string[]>([]);
  const [newZip, setNewZip] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [glAccounts, setGlAccounts] = useState<GLAccountOption[]>([]);

  const fetchGlAccounts = useCallback(async () => {
    const res = await fetch("/api/accounting/gl-accounts");
    if (res.ok) setGlAccounts(await res.json());
  }, []);

  useEffect(() => {
    fetchGlAccounts();
  }, [fetchGlAccounts]);

  useEffect(() => {
    if (item) {
      setForm({
        shortName: item.shortName,
        state: item.state,
        authority: item.authority || "",
        name: item.name,
        reference: item.reference || "",
        glAccountId: item.glAccountId ? String(item.glAccountId) : "",
        isActive: item.isActive,
      });

      // Load full district with ZIP codes
      if (item.zipCodes) {
        setZipCodes(item.zipCodes.map((z) => z.zipCode));
      } else {
        setLoading(true);
        fetch(`/api/tax/districts/${item.id}`)
          .then((r) => r.json())
          .then((data) => {
            setZipCodes((data.zipCodes || []).map((z: TaxDistrictZipCode) => z.zipCode));
          })
          .finally(() => setLoading(false));
      }
    } else {
      setForm({
        shortName: "",
        state: "",
        authority: "",
        name: "",
        reference: "",
        glAccountId: "",
        isActive: true,
      });
      setZipCodes([]);
    }
  }, [item]);

  const addZip = () => {
    const zip = newZip.trim();
    if (zip && !zipCodes.includes(zip)) {
      setZipCodes([...zipCodes, zip]);
    }
    setNewZip("");
  };

  const removeZip = (zip: string) => {
    setZipCodes(zipCodes.filter((z) => z !== zip));
  };

  const handleSubmit = async () => {
    setSaving(true);
    const method = item ? "PUT" : "POST";
    const url = item ? `/api/tax/districts/${item.id}` : "/api/tax/districts";

    const body = item ? { ...form, zipCodes } : form;

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
    if (!confirm(`Delete district "${item.shortName}"? This cannot be undone.`)) return;

    setSaving(true);
    try {
      const res = await fetch(`/api/tax/districts/${item.id}`, { method: "DELETE" });
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
      title={item ? "Edit Tax District" : "Add Tax District"}
      onClose={onClose}
      onSave={handleSubmit}
      saving={saving}
    >
      <div className="grid grid-cols-2 gap-4">
        <FormInput
          label="Short Name"
          name="shortName"
          value={form.shortName}
          onChange={(v) => setForm({ ...form, shortName: v })}
          required
          placeholder="CT"
        />
        <FormInput
          label="State"
          name="state"
          value={form.state}
          onChange={(v) => setForm({ ...form, state: v })}
          required
          placeholder="CT"
        />
      </div>
      <FormInput
        label="Name"
        name="name"
        value={form.name}
        onChange={(v) => setForm({ ...form, name: v })}
        required
        placeholder="Connecticut State Sales Tax"
      />
      <FormInput
        label="Authority"
        name="authority"
        value={form.authority}
        onChange={(v) => setForm({ ...form, authority: v })}
        placeholder="State"
      />
      <div className="grid grid-cols-2 gap-4">
        <FormInput
          label="Reference"
          name="reference"
          value={form.reference}
          onChange={(v) => setForm({ ...form, reference: v })}
        />
        <FormDropdown
          label="GL Account"
          options={glAccounts.map((a) => ({ id: String(a.id), name: `${a.code} - ${a.name}` }))}
          value={form.glAccountId}
          onChange={(v) => setForm({ ...form, glAccountId: v })}
        />
      </div>

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
        <div className="mb-4">
          <label className="block text-sh-blue font-serif mb-1">ZIP Codes</label>
          {loading ? (
            <p className="text-sm text-sh-gray">Loading...</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2 mb-2">
                {zipCodes.map((zip) => (
                  <span
                    key={zip}
                    className="inline-flex items-center gap-1 bg-sh-linen text-sh-black text-sm px-2 py-1 rounded"
                  >
                    {zip}
                    <button
                      type="button"
                      onClick={() => removeZip(zip)}
                      className="text-sh-gray hover:text-red-600"
                    >
                      <X size={14} />
                    </button>
                  </span>
                ))}
                {zipCodes.length === 0 && (
                  <span className="text-sm text-sh-gray">No ZIP codes assigned</span>
                )}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newZip}
                  onChange={(e) => setNewZip(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addZip();
                    }
                  }}
                  placeholder="Add ZIP code"
                  className="border border-sh-gray rounded-lg px-3 py-2 text-sm font-serif w-32"
                />
                <Button type="button" onClick={addZip} disabled={!newZip.trim()}>
                  Add
                </Button>
              </div>
            </>
          )}
        </div>
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
