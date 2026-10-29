// /app/src/components/modals/TenderModal.tsx
//
// Add or edit one of the store's own payment types (Settings -> Payment Types).
// The rules -- reserved names, the kinds, what is fixed once a payment uses it
// -- are lib/payments/tenderShared.ts and lib/payments/tenders.ts; this form
// shows the server's refusal as it stands (rule 11).

import { useState, ChangeEvent } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import FormInput from "@/components/form/FormInput";
import FormCheckbox from "@/components/form/FormCheckbox";
import Modal from "@/components/ui/Modal";
import { getErrorMessage } from "@/lib/toastError";
import { METHOD_DISPLAY } from "@/lib/paymentMethodDisplay";
import { TENDER_KINDS, tenderNameProblem, type TenderKind } from "@/lib/payments/tenderShared";

export interface TenderRow {
  id: number;
  name: string;
  kind: TenderKind;
  isActive: boolean;
  atRegister: boolean;
  onInvoices: boolean;
  referenceRequired: boolean;
  sortOrder: number;
  paymentCount: number;
  glAccount: { code: string; name: string } | null;
}

type Props = {
  item: TenderRow | null;
  onClose: () => void;
  onRefresh: () => void;
};

export default function TenderModal({ item, onClose, onRefresh }: Props) {
  const [form, setForm] = useState({
    name: item?.name ?? "",
    kind: item?.kind ?? ("FINANCE" as TenderKind),
    isActive: item?.isActive ?? true,
    atRegister: item?.atRegister ?? true,
    onInvoices: item?.onInvoices ?? true,
    referenceRequired: item?.referenceRequired ?? false,
    sortOrder: String(item?.sortOrder ?? 0),
  });
  const [saving, setSaving] = useState(false);
  // Name and kind are what its payments are booked and reported under, so
  // they are fixed once there are any (lib/payments/tenders.ts).
  const locked = (item?.paymentCount ?? 0) > 0;

  const flag = (key: "isActive" | "atRegister" | "onInvoices" | "referenceRequired") => ({
    name: key,
    checked: form[key],
    onChange: (e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.checked }),
  });

  const handleSubmit = async () => {
    const problem = tenderNameProblem(form.name);
    if (problem) {
      toast.error(problem);
      return;
    }
    setSaving(true);
    const body = {
      ...(!locked && { name: form.name.trim(), kind: form.kind }),
      isActive: form.isActive,
      atRegister: form.atRegister,
      onInvoices: form.onInvoices,
      referenceRequired: form.referenceRequired,
      sortOrder: Number.parseInt(form.sortOrder, 10) || 0,
    };
    try {
      if (item) await axios.put(`/api/tenders/${item.id}`, body);
      else await axios.post("/api/tenders", body);
      onRefresh();
      onClose();
    } catch (err) {
      toast.error(getErrorMessage(err, "The payment type was not saved."));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!item) return;
    setSaving(true);
    try {
      await axios.delete(`/api/tenders/${item.id}`);
      onRefresh();
      onClose();
    } catch (err) {
      toast.error(getErrorMessage(err, "The payment type was not deleted."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={item ? `Edit ${item.name}` : "Add Payment Type"}
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
        placeholder="The finance company, Zelle, Trade-in"
        disabled={locked}
      />

      <div className="mb-4">
        <label htmlFor="tender-kind" className="block text-brand-blue font-serif mb-1">
          Reports as
        </label>
        <select
          id="tender-kind"
          value={form.kind}
          disabled={locked}
          onChange={(e) => setForm({ ...form, kind: e.target.value as TenderKind })}
          className="w-full border border-brand-gray rounded-lg px-3 py-2 text-brand-black font-serif"
        >
          {TENDER_KINDS.map((k) => (
            <option key={k} value={k}>
              {METHOD_DISPLAY[k]}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-brand-gray">
          {locked
            ? "Payments were taken with this type, so its name and kind are fixed. Switch it off and add a new one to change them."
            : "Totals roll up under this kind, and its payments book to the kind's GL account until you map it separately in Accounting setup."}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        <FormCheckbox label="Offer at the register" {...flag("atRegister")} />
        <FormCheckbox label="Offer on invoices" {...flag("onInvoices")} />
        <FormCheckbox label="Require a reference number" {...flag("referenceRequired")} />
        {item && <FormCheckbox label="Active" {...flag("isActive")} />}
      </div>

      <FormInput
        label="Sort Order"
        name="sortOrder"
        value={form.sortOrder}
        onChange={(v) => setForm({ ...form, sortOrder: v })}
        type="number"
      />

      {item && !locked && (
        <button
          type="button"
          onClick={handleDelete}
          disabled={saving}
          className="mt-2 min-h-[44px] text-sm text-red-700 underline disabled:opacity-50"
        >
          Delete this payment type
        </button>
      )}
    </Modal>
  );
}
