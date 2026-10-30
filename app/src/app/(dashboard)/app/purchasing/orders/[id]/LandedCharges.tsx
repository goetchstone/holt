"use client";

// /app/src/app/(dashboard)/app/purchasing/orders/[id]/LandedCharges.tsx
//
// GAP-02 on the purchase order screen:
//   - LandedChargesPanel: the PO's landed charges (freight, duty, crating),
//     their total, and -- for a writer -- adding one or taking one off. A
//     charge is spread across the lines into their landed cost
//     (lib/purchasing/landedCost.ts). Shown only to a holder of "View cost".
//   - TakeBackModal: take a receipt back, whole or in part
//     (lib/purchasing/unreceive.ts), for a holder of "Adjust inventory".

import { useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";
import {
  LANDED_COST_SPLITS,
  LANDED_COST_SPLIT_KEYS,
  MAX_CHARGE_DESCRIPTION,
  isLandedCostSplit,
  type LandedCostSplit,
} from "@/lib/purchasing/landedCostShared";

export interface PoCharge {
  id: number;
  description: string;
  amount: number;
  splitBy: LandedCostSplit;
  created: string;
  createdBy: string | null;
}

const INPUT = "w-full border border-brand-gray/30 rounded px-3 py-2 text-sm";

/** Tell the buyer about any share that found no stock to land on. */
function reportUnabsorbed(unabsorbed: number, formatCurrency: (n: number) => string) {
  if (Math.abs(unabsorbed) >= 0.01) {
    toast.info(
      `${formatCurrency(Math.abs(unabsorbed))} of it fell on goods already sold out, so no stock's cost moved for that part.`,
    );
  }
}

function AddChargeForm({
  poId,
  defaultSplit,
  onChanged,
}: {
  poId: number;
  defaultSplit: LandedCostSplit;
  onChanged: () => void;
}) {
  const formatCurrency = useMoneyFormatter();
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [splitBy, setSplitBy] = useState<LandedCostSplit>(defaultSplit);
  const [saving, setSaving] = useState(false);

  const add = async () => {
    setSaving(true);
    try {
      const res = await axios.post(`/api/purchasing/orders/${poId}/charges`, {
        description,
        amount: Number(amount),
        splitBy,
      });
      toast.success("Charge added and spread across the lines.");
      reportUnabsorbed(res.data.unabsorbed ?? 0, formatCurrency);
      setDescription("");
      setAmount("");
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't add the charge."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end mt-4 text-sm">
      <div className="md:col-span-2">
        <label className="block text-brand-gray mb-1" htmlFor="charge-description">
          Charge
        </label>
        <input
          id="charge-description"
          className={INPUT}
          value={description}
          maxLength={MAX_CHARGE_DESCRIPTION}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Freight, duty, crating"
        />
      </div>
      <div>
        <label className="block text-brand-gray mb-1" htmlFor="charge-amount">
          Amount
        </label>
        <input
          id="charge-amount"
          type="number"
          min="0"
          step="0.01"
          className={INPUT}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      <div>
        <label className="block text-brand-gray mb-1" htmlFor="charge-split">
          Split
        </label>
        <select
          id="charge-split"
          className={INPUT}
          value={splitBy}
          onChange={(e) => {
            if (isLandedCostSplit(e.target.value)) setSplitBy(e.target.value);
          }}
        >
          {LANDED_COST_SPLIT_KEYS.map((key) => (
            <option key={key} value={key}>
              {LANDED_COST_SPLITS[key].label}
            </option>
          ))}
        </select>
      </div>
      <div className="md:col-span-4 flex justify-between items-center">
        <p className="text-xs text-brand-gray">{LANDED_COST_SPLITS[splitBy].help}</p>
        <Button onClick={add} disabled={saving}>
          {saving ? "Adding..." : "Add charge"}
        </Button>
      </div>
    </div>
  );
}

export function LandedChargesPanel({
  poId,
  charges,
  defaultSplit,
  canWrite,
  open,
  onChanged,
}: {
  poId: number;
  charges: PoCharge[];
  defaultSplit: LandedCostSplit;
  canWrite: boolean;
  /** False on a cancelled PO or a vendor return, which take no charges. */
  open: boolean;
  onChanged: () => void;
}) {
  const formatCurrency = useMoneyFormatter();
  const [removing, setRemoving] = useState<number | null>(null);
  const total = charges.reduce((sum, c) => sum + c.amount, 0);

  const remove = async (charge: PoCharge) => {
    if (!confirm(`Take "${charge.description}" off this PO? Its share comes back off the lines.`)) {
      return;
    }
    setRemoving(charge.id);
    try {
      const res = await axios.delete(`/api/purchasing/orders/${poId}/charges/${charge.id}`);
      toast.success("Charge removed.");
      reportUnabsorbed(res.data.unabsorbed ?? 0, formatCurrency);
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't remove the charge."));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="bg-white p-6 rounded-lg shadow-md mb-6">
      <h2 className="text-xl font-semibold mb-1">Landed charges</h2>
      <p className="text-xs text-brand-gray mb-3">
        Freight, duty and crating, spread across the lines into their landed cost. Goods already
        received take their share now; each product&apos;s landed cost is the average of its
        receipts.
      </p>
      {charges.length === 0 ? (
        <p className="text-sm text-brand-gray">No charges yet.</p>
      ) : (
        <table className="min-w-full text-left text-sm">
          <thead className="bg-brand-linen text-brand-black">
            <tr>
              <th className="p-2 border-b">Charge</th>
              <th className="p-2 border-b">Split</th>
              <th className="p-2 border-b text-right">Amount</th>
              {canWrite && <th className="p-2 border-b" />}
            </tr>
          </thead>
          <tbody>
            {charges.map((c) => (
              <tr key={c.id} className="odd:bg-white even:bg-brand-stripe">
                <td className="p-2 border-b">{c.description}</td>
                <td className="p-2 border-b">
                  {LANDED_COST_SPLITS[c.splitBy]?.label ?? c.splitBy}
                </td>
                <td className="p-2 border-b text-right">{formatCurrency(c.amount)}</td>
                {canWrite && (
                  <td className="p-2 border-b text-right">
                    <button
                      type="button"
                      className="text-sm text-red-700 hover:underline disabled:text-brand-gray"
                      disabled={removing === c.id}
                      onClick={() => remove(c)}
                    >
                      Remove
                    </button>
                  </td>
                )}
              </tr>
            ))}
            <tr>
              <td className="p-2 font-semibold" colSpan={2}>
                Total
              </td>
              <td className="p-2 text-right font-semibold">{formatCurrency(total)}</td>
              {canWrite && <td />}
            </tr>
          </tbody>
        </table>
      )}
      {canWrite && open && (
        <AddChargeForm poId={poId} defaultSplit={defaultSplit} onChanged={onChanged} />
      )}
    </div>
  );
}

export function TakeBackModal({
  receipt,
  onClose,
  onDone,
}: {
  receipt: { id: number; quantityReceived: number; productName?: string; partNo?: string };
  onClose: () => void;
  onDone: () => void;
}) {
  const [quantity, setQuantity] = useState(String(receipt.quantityReceived));
  const [saving, setSaving] = useState(false);

  const takeBack = async () => {
    setSaving(true);
    try {
      await axios.post(`/api/purchasing/receiving/${receipt.id}/unreceive`, {
        quantity: Number(quantity),
      });
      toast.success("Receipt corrected: those units are off the books.");
      onDone();
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't correct the receipt."));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Take back a receipt of ${receipt.productName || receipt.partNo || "this line"}`}
      onClose={onClose}
      onSave={takeBack}
      saving={saving}
      saveLabel="Take back"
      savingLabel="Taking back..."
    >
      <div className="space-y-3 text-sm">
        <p>
          For goods booked in that never came, or came short. The units leave stock from where they
          were received, and come off the product&apos;s landed cost.
        </p>
        <div className="max-w-[10rem]">
          <label className="block text-brand-gray mb-1" htmlFor="take-back-qty">
            Quantity to take back (of {receipt.quantityReceived})
          </label>
          <input
            id="take-back-qty"
            type="number"
            min="0"
            step="any"
            max={receipt.quantityReceived}
            className={INPUT}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}
