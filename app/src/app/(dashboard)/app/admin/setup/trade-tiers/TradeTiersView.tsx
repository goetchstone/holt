"use client";

// /app/src/app/(dashboard)/app/admin/setup/trade-tiers/TradeTiersView.tsx
//
// Trade Tiers body. App Router port of the legacy admin/setup/trade-tiers body
// (minus MainLayout chrome, which the (dashboard) layout supplies). CRUD over
// the shared /api/admin/trade-tiers REST endpoint.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";
import FormInput from "@/components/form/FormInput";
import FormCheckbox from "@/components/form/FormCheckbox";
import { getErrorMessage } from "@/lib/toastError";

interface TradeTier {
  id: number;
  name: string;
  discountPercent: number;
  sortOrder: number;
  isActive: boolean;
}

interface TierForm {
  name: string;
  discountPercent: string;
  sortOrder: string;
  isActive: boolean;
}

const emptyForm: TierForm = {
  name: "",
  discountPercent: "",
  sortOrder: "0",
  isActive: true,
};

export function TradeTiersView() {
  const [tiers, setTiers] = useState<TradeTier[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<{ editing: TradeTier | null } | null>(null);
  const [form, setForm] = useState<TierForm>(emptyForm);
  const [saving, setSaving] = useState(false);

  const fetchTiers = useCallback(async () => {
    try {
      const { data } = await axios.get<TradeTier[]>("/api/admin/trade-tiers");
      setTiers(
        (data || []).map((t) => ({
          ...t,
          discountPercent: Number(t.discountPercent),
        })),
      );
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load trade tiers"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTiers();
  }, [fetchTiers]);

  const openModal = (tier: TradeTier | null) => {
    setForm(
      tier
        ? {
            name: tier.name,
            discountPercent: String(tier.discountPercent),
            sortOrder: String(tier.sortOrder),
            isActive: tier.isActive,
          }
        : emptyForm,
    );
    setModal({ editing: tier });
  };

  const saveTier = async () => {
    if (!form.name.trim()) {
      toast.error("Name is required");
      return;
    }
    const discount = Number.parseFloat(form.discountPercent);
    if (Number.isNaN(discount) || discount < 0 || discount > 100) {
      toast.error("Discount must be between 0 and 100");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        discountPercent: discount,
        sortOrder: Number.parseInt(form.sortOrder) || 0,
        isActive: form.isActive,
      };
      if (modal?.editing) {
        await axios.put(`/api/admin/trade-tiers/${modal.editing.id}`, payload);
      } else {
        await axios.post("/api/admin/trade-tiers", payload);
      }
      setModal(null);
      toast.success("Trade tier saved");
      fetchTiers();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to save"));
    } finally {
      setSaving(false);
    }
  };

  const deactivateTier = async (tier: TradeTier) => {
    try {
      await axios.delete(`/api/admin/trade-tiers/${tier.id}`);
      toast.success(`${tier.name} deactivated`);
      fetchTiers();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to deactivate tier"));
    }
  };

  return (
    <div className="container mx-auto px-4 py-8 font-serif">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold text-sh-black">Trade Tiers</h1>
          <p className="text-sm text-sh-gray mt-1">
            Discount tiers for trade customers, applied to anchor pricing.
          </p>
        </div>
        <Button onClick={() => openModal(null)}>
          <Plus className="w-4 h-4 mr-2" />
          Add Tier
        </Button>
      </div>

      {loading && <p className="text-sh-gray">Loading...</p>}

      {!loading && tiers.length === 0 && (
        <div className="bg-white rounded-lg shadow-md p-8 text-center text-sh-gray">
          No trade tiers configured yet. Add one to get started.
        </div>
      )}

      {!loading && tiers.length > 0 && (
        <div className="bg-white rounded-lg shadow-md overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-sh-gray/20 text-left">
                <th className="px-4 py-3 font-semibold text-sh-black">Tier Name</th>
                <th className="px-4 py-3 font-semibold text-sh-black text-right">Discount %</th>
                <th className="px-4 py-3 font-semibold text-sh-black text-right">Sort Order</th>
                <th className="px-4 py-3 font-semibold text-sh-black text-center">Active</th>
                <th className="px-4 py-3 font-semibold text-sh-black text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((tier, i) => (
                <tr
                  key={tier.id}
                  className={`border-b border-sh-gray/10 ${i % 2 === 1 ? "bg-sh-stripe" : ""}`}
                >
                  <td className="px-4 py-3 font-medium text-sh-black">{tier.name}</td>
                  <td className="px-4 py-3 text-right">{tier.discountPercent}%</td>
                  <td className="px-4 py-3 text-right">{tier.sortOrder}</td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        tier.isActive ? "bg-green-100 text-green-800" : "bg-sh-gray/20 text-sh-gray"
                      }`}
                    >
                      {tier.isActive ? "Yes" : "No"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right space-x-2">
                    <Button size="sm" variant="outline" onClick={() => openModal(tier)}>
                      Edit
                    </Button>
                    {tier.isActive && (
                      <Button size="sm" variant="secondary" onClick={() => deactivateTier(tier)}>
                        Deactivate
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <Modal
          title={modal.editing ? "Edit Trade Tier" : "Add Trade Tier"}
          onClose={() => setModal(null)}
          onSave={saveTier}
          saving={saving}
        >
          <FormInput
            label="Tier Name"
            name="name"
            value={form.name}
            onChange={(v) => setForm((prev) => ({ ...prev, name: v }))}
            placeholder="e.g. Designer, Architect, Developer"
          />
          <FormInput
            label="Discount %"
            name="discountPercent"
            type="number"
            value={form.discountPercent}
            onChange={(v) => setForm((prev) => ({ ...prev, discountPercent: v }))}
            placeholder="e.g. 20 for 20% off anchor"
          />
          <FormInput
            label="Sort Order"
            name="sortOrder"
            type="number"
            value={form.sortOrder}
            onChange={(v) => setForm((prev) => ({ ...prev, sortOrder: v }))}
          />
          <FormCheckbox
            label="Active"
            name="isActive"
            checked={form.isActive}
            onChange={(e) => setForm((prev) => ({ ...prev, isActive: e.target.checked }))}
          />
        </Modal>
      )}
    </div>
  );
}
