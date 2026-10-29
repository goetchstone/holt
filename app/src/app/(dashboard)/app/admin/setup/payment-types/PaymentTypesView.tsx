"use client";

// /app/src/app/(dashboard)/app/admin/setup/payment-types/PaymentTypesView.tsx
//
// Settings -> Payment Types: the tenders a store sets up for itself on top of
// the built-in ones (lib/payments/tenders.ts). Reads and writes /api/tenders.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import TenderModal, { type TenderRow } from "@/components/modals/TenderModal";
import { getErrorMessage } from "@/lib/toastError";
import { METHOD_DISPLAY } from "@/lib/paymentMethodDisplay";

const BUILT_IN = ["CASH", "CARD", "CHECK", "GIFT_CARD", "STORE_CREDIT"] as const;

function offeredOn(t: TenderRow): string {
  const where = [t.atRegister && "Register", t.onInvoices && "Invoices"].filter(Boolean);
  return where.length > 0 ? where.join(", ") : "Nowhere";
}

export function PaymentTypesView() {
  const [tenders, setTenders] = useState<TenderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalItem, setModalItem] = useState<TenderRow | null | undefined>(undefined);

  // A promise chain rather than an awaited call, so the effect sets no state
  // synchronously (react-hooks/set-state-in-effect).
  const fetchTenders = useCallback(
    () =>
      axios
        .get<TenderRow[]>("/api/tenders")
        .then((res) => setTenders(res.data))
        .catch((err: unknown) => toast.error(getErrorMessage(err, "Failed to load payment types")))
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    void fetchTenders();
  }, [fetchTenders]);

  return (
    <div className="py-2 font-serif">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-2xl text-brand-gray">
          <p>
            Add the ways your customers pay beyond the built-in{" "}
            {BUILT_IN.map((m) => METHOD_DISPLAY[m]).join(", ")}: each finance company, Zelle, a
            trade-in. Each one is offered at the register, on invoices, or both.
          </p>
          <p className="mt-2 text-sm">
            A new payment type books to its kind&apos;s GL account. To give it its own account, map
            it under POS Payments in{" "}
            <Link href="/app/admin/setup/accounting" className="text-brand-blue underline">
              Chart of Accounts
            </Link>
            .
          </p>
        </div>
        <Button onClick={() => setModalItem(null)}>Add Payment Type</Button>
      </div>

      {loading && <p className="text-brand-gray">Loading...</p>}
      {!loading && tenders.length === 0 && (
        <p className="text-brand-gray">No payment types of your own yet.</p>
      )}
      {!loading && tenders.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-brand-gray/30 text-left">
                <th className="py-3 px-4 font-semibold text-brand-blue">Name</th>
                <th className="py-3 px-4 font-semibold text-brand-blue">Reports as</th>
                <th className="py-3 px-4 font-semibold text-brand-blue">Offered on</th>
                <th className="py-3 px-4 font-semibold text-brand-blue">Reference</th>
                <th className="py-3 px-4 font-semibold text-brand-blue">GL account</th>
                <th className="py-3 px-4 font-semibold text-brand-blue text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {tenders.map((t, i) => (
                <tr
                  key={t.id}
                  onClick={() => setModalItem(t)}
                  className={`border-b border-brand-gray/10 cursor-pointer hover:bg-brand-linen/50 ${
                    i % 2 === 0 ? "bg-white" : "bg-brand-stripe"
                  }`}
                >
                  <td className="py-3 px-4 font-semibold text-brand-blue">{t.name}</td>
                  <td className="py-3 px-4 text-brand-black">{METHOD_DISPLAY[t.kind]}</td>
                  <td className="py-3 px-4 text-brand-black">{offeredOn(t)}</td>
                  <td className="py-3 px-4 text-brand-black">
                    {t.referenceRequired ? "Required" : "Optional"}
                  </td>
                  <td className="py-3 px-4 text-brand-black">
                    {t.glAccount ? (
                      `${t.glAccount.code} ${t.glAccount.name}`
                    ) : (
                      <span className="text-red-700">Not mapped</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-center">
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full text-xs font-serif-condensed ${
                        t.isActive
                          ? "bg-green-100 text-green-800"
                          : "bg-brand-gray/20 text-brand-gray"
                      }`}
                    >
                      {t.isActive ? "Active" : "Off"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalItem !== undefined && (
        <TenderModal
          item={modalItem}
          onClose={() => setModalItem(undefined)}
          onRefresh={fetchTenders}
        />
      )}
    </div>
  );
}
