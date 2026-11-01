"use client";

// GAP-16: set stock at a place aside as damaged. The units go to the store's
// quarantine place, off sale, with what is wrong on the journal
// (POST /api/inventory/set-aside/damaged, lib/inventory/setAside.ts). From
// Warehouse › Set aside they are put back or written off.

import { useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import Modal from "@/components/ui/Modal";
import { getErrorMessage } from "@/lib/toastError";

interface Props {
  position: {
    id: number;
    productName: string;
    stockLocationName: string | null;
    quantity: number;
    salesOrderNo: string | null;
  };
  onClose: () => void;
  onDone: () => void;
}

export function SetAsideDamagedDialog({ position, onClose, onDone }: Readonly<Props>) {
  const [quantity, setQuantity] = useState(String(Math.min(1, position.quantity)));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await axios.post("/api/inventory/set-aside/damaged", {
        positionId: position.id,
        quantity: Number(quantity),
        note,
      });
      toast.success("Set aside as damaged.");
      onDone();
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't set it aside."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Damaged: ${position.productName}`}
      onClose={onClose}
      onSave={save}
      saving={saving}
      saveLabel="Set aside"
      savingLabel="Setting aside..."
    >
      <p className="mb-3 text-sm text-brand-gray">
        It goes to this store&apos;s quarantine place, off sale, until it is put back or written off
        under Warehouse › Set aside.
        {position.salesOrderNo &&
          ` It is committed to ${position.salesOrderNo}, which will draw another unit or show as short.`}
      </p>
      <label htmlFor="damaged-qty" className="mb-1 block text-sm text-brand-gray">
        How many (of {position.quantity}
        {position.stockLocationName ? ` at ${position.stockLocationName}` : ""})
      </label>
      <input
        id="damaged-qty"
        type="number"
        min={0}
        max={position.quantity}
        step="any"
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        className="mb-3 w-32 rounded border border-brand-gray/30 px-2 py-1 text-sm"
      />
      <label htmlFor="damaged-note" className="mb-1 block text-sm text-brand-gray">
        What is wrong
      </label>
      <textarea
        id="damaged-note"
        rows={3}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        className="w-full rounded border border-brand-gray/30 px-2 py-1 text-sm"
      />
    </Modal>
  );
}
