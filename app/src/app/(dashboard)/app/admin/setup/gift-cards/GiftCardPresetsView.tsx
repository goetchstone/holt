"use client";

// /app/src/app/(dashboard)/app/admin/setup/gift-cards/GiftCardPresetsView.tsx
//
// Gift Card Presets body. App Router port of the legacy admin/setup/gift-cards
// body (minus MainLayout chrome, which the (dashboard) layout supplies). Lists
// quick gift-card codes and edits them via the shared GiftCardPresetModal +
// /api/gift-cards/presets REST endpoint.

import { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import GiftCardPresetModal from "@/components/modals/GiftCardPresetModal";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";

interface Preset {
  id: number;
  code: string;
  amount: number | null;
  label: string;
  isActive: boolean;
  sortOrder: number;
}

export function GiftCardPresetsView() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalItem, setModalItem] = useState<Preset | null | undefined>(undefined);
  const formatMoney = useMoneyFormatter();

  const fetchPresets = useCallback(async () => {
    try {
      const res = await fetch("/api/gift-cards/presets");
      if (res.ok) setPresets(await res.json());
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load presets"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPresets();
  }, [fetchPresets]);

  return (
    <div className="py-2 font-serif">
      <div className="flex justify-between items-center mb-6">
        <p className="text-sh-gray">
          Quick codes for gift card sales. Type a code at the POS to sell a gift card.
        </p>
        <Button onClick={() => setModalItem(null)}>Add Preset</Button>
      </div>

      {loading ? (
        <p className="text-sh-gray">Loading...</p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-sh-gray/30 text-left">
              <th className="py-3 px-4 font-semibold text-sh-blue">Code</th>
              <th className="py-3 px-4 font-semibold text-sh-blue">Label</th>
              <th className="py-3 px-4 font-semibold text-sh-blue text-right">Amount</th>
              <th className="py-3 px-4 font-semibold text-sh-blue text-center">Status</th>
              <th className="py-3 px-4 font-semibold text-sh-blue text-right">Order</th>
            </tr>
          </thead>
          <tbody>
            {presets.map((p, i) => (
              <tr
                key={p.id}
                onClick={() => setModalItem(p)}
                className={`border-b border-sh-gray/10 cursor-pointer hover:bg-sh-linen/50 ${
                  i % 2 === 0 ? "bg-white" : "bg-sh-stripe"
                }`}
              >
                <td className="py-3 px-4 font-semibold text-sh-blue">{p.code}</td>
                <td className="py-3 px-4 text-sh-black">{p.label}</td>
                <td className="py-3 px-4 text-sh-black text-right">
                  {p.amount !== null ? formatMoney(p.amount) : "Custom"}
                </td>
                <td className="py-3 px-4 text-center">
                  <span
                    className={`inline-block px-2 py-0.5 rounded-full text-xs font-serif-condensed ${
                      p.isActive ? "bg-green-100 text-green-800" : "bg-sh-gray/20 text-sh-gray"
                    }`}
                  >
                    {p.isActive ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="py-3 px-4 text-sh-gray text-right">{p.sortOrder}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {modalItem !== undefined && (
        <GiftCardPresetModal
          item={modalItem}
          onClose={() => setModalItem(undefined)}
          onRefresh={fetchPresets}
        />
      )}
    </div>
  );
}
