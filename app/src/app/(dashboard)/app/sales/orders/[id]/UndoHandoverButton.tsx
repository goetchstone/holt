"use client";

// GAP-07: undo a handover recorded by mistake, on the order screen. Shown to
// someone holding "Undo a handover" on an order that has been handed over. It
// asks why, then POSTs orders/[id]/undo-handover (lib/fulfilment/undoHandover.ts):
// the units come back on the books committed to the order, the order reopens,
// and a delivery goes back in the dispatch pool. The server refuses once
// commission on the order is paid out, or goods on it are being returned.

import { useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Undo2 } from "lucide-react";
import { format } from "date-fns";
import Modal from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

interface Props {
  orderId: number;
  orderno: string;
  deliveredAt: string;
  onUndone: () => void;
}

export function UndoHandoverButton({ orderId, orderno, deliveredAt, onUndone }: Readonly<Props>) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const undo = async () => {
    setSaving(true);
    try {
      const res = await axios.post<{ unitsBack: number }>(
        `/api/sales/orders/${encodeURIComponent(String(orderId))}/undo-handover`,
        { reason },
      );
      toast.success(
        `Handover undone: ${res.data.unitsBack} unit(s) back on the books for ${orderno}.`,
      );
      setOpen(false);
      setReason("");
      onUndone();
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't undo the handover."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Undo2 className="w-3.5 h-3.5 mr-1" />
        Undo handover
      </Button>
      {open && (
        <Modal
          title={`Undo the handover of ${orderno}?`}
          onClose={() => setOpen(false)}
          onSave={undo}
          saving={saving}
          saveLabel="Undo handover"
          savingLabel="Undoing..."
        >
          <p className="text-sm text-brand-gray">
            Recorded as handed over on {format(new Date(deliveredAt), "PPP p")}. Undoing it puts the
            units back on the books, committed to this order, where they left from (a truck&apos;s
            go to the store&apos;s loading bay). The order reopens, and a delivery goes back to
            dispatch to be scheduled again.
          </p>
          <label htmlFor="undo-reason" className="block text-sm font-medium">
            Why?
          </label>
          <textarea
            id="undo-reason"
            value={reason}
            maxLength={500}
            rows={3}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Completed the wrong stop on the run, so it never left the truck."
            className="w-full rounded border border-brand-gray/30 px-3 py-2 text-sm"
          />
        </Modal>
      )}
    </>
  );
}
