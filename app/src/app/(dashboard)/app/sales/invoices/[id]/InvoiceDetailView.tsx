"use client";

// /app/src/app/(dashboard)/app/sales/invoices/[id]/InvoiceDetailView.tsx
//
// Invoice detail: header, lines, totals, applied payments, and the lifecycle
// action bar. DRAFT: edit / issue / delete. ISSUED: record payment, email
// (with optional pay link), copy payment link, void. PDF always available.
// Issue is the books step (AR journal + SALE ledger entry) — confirmed before
// firing.

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "react-toastify";
import { Loader2 } from "lucide-react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";
import { INVOICE_PAYMENT_METHODS, type InvoicePaymentMethod } from "@/lib/billing/invoiceShared";

const STATUS_BADGE: Record<string, string> = {
  DRAFT: "bg-sh-stripe text-sh-gray",
  ISSUED: "bg-amber-100 text-amber-800",
  PAID: "bg-green-100 text-green-800",
  VOID: "bg-red-100 text-red-800",
};

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

export function InvoiceDetailView({ invoiceId }: { invoiceId: number }) {
  const router = useRouter();
  const money = useMoneyFormatter();
  const utils = api.useUtils();

  const query = api.billing.detail.useQuery({ id: invoiceId });
  const invoice = query.data;

  const issue = api.billing.issue.useMutation();
  const remove = api.billing.delete.useMutation();
  const voidMut = api.billing.void.useMutation();
  const recordPayment = api.billing.recordPayment.useMutation();
  const sendEmail = api.billing.sendEmail.useMutation();
  const paymentLink = api.billing.paymentLink.useMutation();

  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState<InvoicePaymentMethod>("CHECK");
  const [payReference, setPayReference] = useState("");
  const [includeLink, setIncludeLink] = useState(true);

  const refresh = () => utils.billing.detail.invalidate({ id: invoiceId });

  const onIssue = async () => {
    if (!window.confirm("Issue this invoice? It posts to the books and becomes uneditable.")) {
      return;
    }
    try {
      await issue.mutateAsync({ id: invoiceId });
      toast.success("Invoice issued");
      refresh();
    } catch (err) {
      toast.error(errMessage(err));
    }
  };

  const onDelete = async () => {
    if (!window.confirm("Delete this draft invoice?")) return;
    try {
      await remove.mutateAsync({ id: invoiceId });
      toast.success("Draft deleted");
      router.push("/app/sales/invoices");
    } catch (err) {
      toast.error(errMessage(err));
    }
  };

  const onVoid = async () => {
    if (!window.confirm("Void this invoice? An issued invoice gets a reversing entry.")) return;
    try {
      await voidMut.mutateAsync({ id: invoiceId });
      toast.success("Invoice voided");
      refresh();
    } catch (err) {
      toast.error(errMessage(err));
    }
  };

  const onRecordPayment = async () => {
    try {
      const result = await recordPayment.mutateAsync({
        id: invoiceId,
        amount: Number(payAmount),
        method: payMethod,
        reference: payReference.trim() || null,
      });
      toast.success(
        result.openBalance <= 0
          ? "Payment recorded — invoice paid in full"
          : `Payment recorded — ${money(result.openBalance)} still open`,
      );
      setShowPaymentForm(false);
      setPayAmount("");
      setPayReference("");
      refresh();
    } catch (err) {
      toast.error(errMessage(err));
    }
  };

  const onSendEmail = async () => {
    try {
      const result = await sendEmail.mutateAsync({
        id: invoiceId,
        includePaymentLink: includeLink,
      });
      toast.success(`Invoice emailed to ${result.to}`);
    } catch (err) {
      toast.error(errMessage(err));
    }
  };

  const onPaymentLink = async () => {
    try {
      const result = await paymentLink.mutateAsync({ id: invoiceId });
      await navigator.clipboard.writeText(result.url);
      toast.success(`Payment link for ${money(result.amount)} copied to clipboard`);
    } catch (err) {
      toast.error(errMessage(err));
    }
  };

  if (query.isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-sh-gold" />
      </div>
    );
  }
  if (!invoice) {
    return <p className="py-16 text-center text-sh-gray">Invoice not found.</p>;
  }

  const busy =
    issue.isPending ||
    remove.isPending ||
    voidMut.isPending ||
    recordPayment.isPending ||
    sendEmail.isPending ||
    paymentLink.isPending;

  return (
    <div className="max-w-3xl space-y-6 font-serif">
      <nav className="text-sm text-sh-gray">
        <Link href="/app/sales/invoices" className="hover:underline">
          Invoices
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">{invoice.invoiceNo}</span>
      </nav>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-sh-navy">{invoice.invoiceNo}</h1>
          <p className="text-sm text-sh-gray">
            {invoice.customerName}
            {invoice.customerEmail ? ` · ${invoice.customerEmail}` : ""}
          </p>
        </div>
        <span className={`rounded-full px-3 py-1 text-sm ${STATUS_BADGE[invoice.status] ?? ""}`}>
          {invoice.status}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        {invoice.status === "DRAFT" && (
          <>
            <Link
              href={`/app/sales/invoices/${invoiceId}/edit`}
              className="inline-flex min-h-[44px] items-center rounded-lg border border-gray-300 px-4 text-sm text-sh-black transition hover:bg-sh-linen"
            >
              Edit
            </Link>
            <button
              type="button"
              onClick={onIssue}
              disabled={busy}
              className="min-h-[44px] rounded-lg bg-sh-navy px-5 text-sm font-semibold text-white transition hover:bg-sh-blue disabled:opacity-50"
            >
              {issue.isPending ? "Issuing..." : "Issue Invoice"}
            </button>
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              className="min-h-[44px] rounded-lg border border-red-300 px-4 text-sm text-red-700 transition hover:bg-red-50 disabled:opacity-50"
            >
              Delete
            </button>
          </>
        )}
        {invoice.status === "ISSUED" && (
          <>
            <button
              type="button"
              onClick={() => setShowPaymentForm((v) => !v)}
              disabled={busy}
              className="min-h-[44px] rounded-lg bg-sh-navy px-5 text-sm font-semibold text-white transition hover:bg-sh-blue disabled:opacity-50"
            >
              Record Payment
            </button>
            <button
              type="button"
              onClick={onSendEmail}
              disabled={busy || !invoice.customerEmail}
              className="min-h-[44px] rounded-lg border border-gray-300 px-4 text-sm text-sh-black transition hover:bg-sh-linen disabled:opacity-50"
            >
              {sendEmail.isPending ? "Sending..." : "Email Invoice"}
            </button>
            <label className="flex items-center gap-1 text-xs text-sh-gray">
              <input
                type="checkbox"
                checked={includeLink}
                onChange={(e) => setIncludeLink(e.target.checked)}
              />
              include pay link
            </label>
            <button
              type="button"
              onClick={onPaymentLink}
              disabled={busy}
              className="min-h-[44px] rounded-lg border border-gray-300 px-4 text-sm text-sh-black transition hover:bg-sh-linen disabled:opacity-50"
            >
              {paymentLink.isPending ? "Creating..." : "Copy Payment Link"}
            </button>
            <button
              type="button"
              onClick={onVoid}
              disabled={busy}
              className="min-h-[44px] rounded-lg border border-red-300 px-4 text-sm text-red-700 transition hover:bg-red-50 disabled:opacity-50"
            >
              Void
            </button>
          </>
        )}
        <a
          href={`/api/billing/invoices/${invoiceId}/pdf`}
          className="inline-flex min-h-[44px] items-center rounded-lg border border-gray-300 px-4 text-sm text-sh-black transition hover:bg-sh-linen"
        >
          Download PDF
        </a>
      </div>

      {showPaymentForm && invoice.status === "ISSUED" && (
        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-sh-gray/20 bg-sh-linen p-4">
          <div>
            <label htmlFor="payAmount" className="mb-1 block text-xs font-medium text-sh-gray">
              Amount (open: {money(invoice.openBalance)})
            </label>
            <input
              id="payAmount"
              type="number"
              min="0.01"
              step="0.01"
              value={payAmount}
              onChange={(e) => setPayAmount(e.target.value)}
              className="min-h-[44px] w-32 rounded border border-gray-300 px-3 text-right text-sm"
            />
          </div>
          <div>
            <label htmlFor="payMethod" className="mb-1 block text-xs font-medium text-sh-gray">
              Method
            </label>
            <select
              id="payMethod"
              value={payMethod}
              onChange={(e) => setPayMethod(e.target.value as InvoicePaymentMethod)}
              className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
            >
              {INVOICE_PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m.charAt(0) + m.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="payRef" className="mb-1 block text-xs font-medium text-sh-gray">
              Reference (check #)
            </label>
            <input
              id="payRef"
              type="text"
              value={payReference}
              onChange={(e) => setPayReference(e.target.value)}
              className="min-h-[44px] w-32 rounded border border-gray-300 px-3 text-sm"
            />
          </div>
          <button
            type="button"
            onClick={onRecordPayment}
            disabled={recordPayment.isPending || Number(payAmount) <= 0}
            className="min-h-[44px] rounded-lg bg-sh-navy px-5 text-sm font-semibold text-white transition hover:bg-sh-blue disabled:opacity-50"
          >
            {recordPayment.isPending ? "Recording..." : "Record"}
          </button>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-sh-gray/20 bg-white shadow-md">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-sh-gray/20 bg-sh-linen">
              <th className="px-4 py-3 text-left font-semibold text-sh-gray">Description</th>
              <th className="px-4 py-3 text-right font-semibold text-sh-gray">Qty</th>
              <th className="px-4 py-3 text-right font-semibold text-sh-gray">Unit</th>
              <th className="px-4 py-3 text-right font-semibold text-sh-gray">Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((l, i) => (
              <tr
                key={l.id}
                className={`border-b border-sh-gray/10 ${i % 2 === 1 ? "bg-sh-stripe" : ""}`}
              >
                <td className="px-4 py-3">{l.description}</td>
                <td className="px-4 py-3 text-right">{l.quantity}</td>
                <td className="px-4 py-3 text-right text-sh-gray">{money(l.unitPrice)}</td>
                <td className="px-4 py-3 text-right">{money(l.amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-sh-linen text-sh-gray">
              <td colSpan={3} className="px-4 py-2 text-right">
                Subtotal
              </td>
              <td className="px-4 py-2 text-right">{money(invoice.subtotal)}</td>
            </tr>
            <tr className="bg-sh-linen text-sh-gray">
              <td colSpan={3} className="px-4 py-2 text-right">
                Tax
              </td>
              <td className="px-4 py-2 text-right">{money(invoice.taxAmount)}</td>
            </tr>
            <tr className="border-t-2 border-sh-navy bg-sh-linen font-semibold text-sh-navy">
              <td colSpan={3} className="px-4 py-3 text-right">
                Total
              </td>
              <td className="px-4 py-3 text-right">{money(invoice.total)}</td>
            </tr>
            {invoice.status === "ISSUED" && (
              <tr className="bg-sh-linen font-semibold text-amber-800">
                <td colSpan={3} className="px-4 py-2 text-right">
                  Balance due
                </td>
                <td className="px-4 py-2 text-right">{money(invoice.openBalance)}</td>
              </tr>
            )}
          </tfoot>
        </table>
      </div>

      {invoice.payments.length > 0 && (
        <div>
          <h2 className="mb-2 text-lg font-semibold text-sh-navy">Payments</h2>
          <div className="overflow-hidden rounded-lg border border-sh-gray/20 bg-white shadow-md">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-sh-gray/20 bg-sh-linen">
                  <th className="px-4 py-3 text-left font-semibold text-sh-gray">Date</th>
                  <th className="px-4 py-3 text-left font-semibold text-sh-gray">Type</th>
                  <th className="px-4 py-3 text-right font-semibold text-sh-gray">Applied</th>
                  <th className="px-4 py-3 text-left font-semibold text-sh-gray">Status</th>
                </tr>
              </thead>
              <tbody>
                {invoice.payments.map((p) => (
                  <tr key={p.paymentId} className="border-b border-sh-gray/10">
                    <td className="px-4 py-3">
                      {new Date(p.paymentDate).toLocaleDateString("en-US", { timeZone: "UTC" })}
                    </td>
                    <td className="px-4 py-3">{p.paymentType}</td>
                    <td className="px-4 py-3 text-right">{money(p.amountApplied)}</td>
                    <td className="px-4 py-3 text-sh-gray">{p.status ?? "--"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {invoice.notes && (
        <div>
          <h2 className="mb-1 text-lg font-semibold text-sh-navy">Notes</h2>
          <p className="whitespace-pre-wrap text-sm text-sh-gray">{invoice.notes}</p>
        </div>
      )}
    </div>
  );
}
