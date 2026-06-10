"use client";

// /app/src/app/(dashboard)/app/sales/invoices/InvoiceComposer.tsx
//
// Shared composer for new + edit (DRAFT only). Customer search-as-you-type,
// freeform line rows (description / qty / unit price), tax %, due date,
// notes. Saving creates/updates the DRAFT; issuing happens on the detail
// page so the books step is always a deliberate second action.

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "react-toastify";
import { Trash2, Plus } from "lucide-react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { useCustomerSearch, type CustomerSearchResult } from "@/hooks/useCustomerSearch";
import { api } from "@/lib/trpc/client";

export interface ComposerInitial {
  id: number;
  customerId: number;
  customerName: string;
  lines: { description: string; quantity: number; unitPrice: number }[];
  taxRate: number;
  dueDate: string | null;
  notes: string | null;
}

interface LineRow {
  description: string;
  quantity: string;
  unitPrice: string;
}

const EMPTY_LINE: LineRow = { description: "", quantity: "1", unitPrice: "" };

function toIsoDateInput(value: string | null): string {
  return value ? value.slice(0, 10) : "";
}

export function InvoiceComposer({ initial }: { initial?: ComposerInitial }) {
  const router = useRouter();
  const money = useMoneyFormatter();

  const [customer, setCustomer] = useState<{ id: number; name: string } | null>(
    initial ? { id: initial.customerId, name: initial.customerName } : null,
  );
  const [lines, setLines] = useState<LineRow[]>(
    initial
      ? initial.lines.map((l) => ({
          description: l.description,
          quantity: String(l.quantity),
          unitPrice: String(l.unitPrice),
        }))
      : [{ ...EMPTY_LINE }],
  );
  const [taxPct, setTaxPct] = useState(initial ? (initial.taxRate * 100).toFixed(2) : "0");
  const [dueDate, setDueDate] = useState(toIsoDateInput(initial?.dueDate ?? null));
  const [notes, setNotes] = useState(initial?.notes ?? "");

  const search = useCustomerSearch({ limit: 8 });
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const create = api.billing.create.useMutation();
  const update = api.billing.update.useMutation();
  const saving = create.isPending || update.isPending;

  const totals = useMemo(() => {
    let subtotal = 0;
    for (const l of lines) {
      const qty = Number(l.quantity);
      const price = Number(l.unitPrice);
      if (Number.isFinite(qty) && Number.isFinite(price) && qty > 0 && price >= 0) {
        subtotal += Math.round(qty * price * 100) / 100;
      }
    }
    subtotal = Math.round(subtotal * 100) / 100;
    const rate = Number(taxPct) / 100;
    const tax = Number.isFinite(rate) && rate > 0 ? Math.round(subtotal * rate * 100) / 100 : 0;
    return { subtotal, tax, total: Math.round((subtotal + tax) * 100) / 100 };
  }, [lines, taxPct]);

  const setLine = (i: number, patch: Partial<LineRow>) => {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  };

  const pickCustomer = (c: CustomerSearchResult) => {
    setCustomer({ id: c.id, name: [c.firstName, c.lastName].filter(Boolean).join(" ") });
    search.clear();
    setShowDropdown(false);
  };

  const save = async () => {
    if (!customer) {
      toast.error("Pick a customer first");
      return;
    }
    const parsedLines = lines
      .filter((l) => l.description.trim() || l.unitPrice)
      .map((l) => ({
        description: l.description.trim(),
        quantity: Number(l.quantity),
        unitPrice: Number(l.unitPrice),
      }));
    if (parsedLines.length === 0) {
      toast.error("Add at least one line");
      return;
    }
    const payload = {
      customerId: customer.id,
      lines: parsedLines,
      taxRate: Number(taxPct) > 0 ? Number(taxPct) / 100 : undefined,
      dueDate: dueDate || null,
      notes: notes.trim() || null,
    };
    try {
      if (initial) {
        await update.mutateAsync({ id: initial.id, ...payload });
        toast.success("Draft updated");
        router.push(`/app/sales/invoices/${initial.id}`);
      } else {
        const created = await create.mutateAsync(payload);
        toast.success("Draft created");
        router.push(`/app/sales/invoices/${created.id}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save invoice");
    }
  };

  return (
    <div className="max-w-3xl space-y-6 font-serif">
      <nav className="text-sm text-sh-gray">
        <Link href="/app/sales/invoices" className="hover:underline">
          Invoices
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">{initial ? `Edit ${initial.id}` : "New"}</span>
      </nav>
      <h1 className="text-2xl font-semibold text-sh-navy">
        {initial ? "Edit Draft Invoice" : "New Invoice"}
      </h1>

      <div ref={dropdownRef} className="relative">
        <label htmlFor="invCustomer" className="mb-1 block text-xs font-medium text-sh-gray">
          Customer
        </label>
        {customer ? (
          <div className="flex min-h-[44px] items-center justify-between rounded border border-gray-300 bg-sh-linen px-3">
            <span className="font-semibold text-sh-navy">{customer.name}</span>
            <button
              type="button"
              onClick={() => setCustomer(null)}
              className="text-sm text-sh-gray hover:text-sh-black"
            >
              Change
            </button>
          </div>
        ) : (
          <>
            <input
              id="invCustomer"
              type="text"
              value={search.query}
              onChange={(e) => {
                search.setQuery(e.target.value);
                setShowDropdown(true);
              }}
              placeholder="Search customers by name, email, or phone..."
              className="min-h-[44px] w-full rounded border border-gray-300 px-3 text-sm"
            />
            {showDropdown && search.results.length > 0 && (
              <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded border border-gray-300 bg-white shadow-lg">
                {search.results.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => pickCustomer(c)}
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-sh-linen"
                    >
                      <span className="font-semibold">
                        {[c.firstName, c.lastName].filter(Boolean).join(" ")}
                      </span>
                      {c.email ? <span className="text-sh-gray"> · {c.email}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="space-y-2">
        <span className="block text-xs font-medium text-sh-gray">Lines</span>
        {lines.map((line, i) => (
          <div key={i} className="flex items-start gap-2">
            <input
              type="text"
              value={line.description}
              onChange={(e) => setLine(i, { description: e.target.value })}
              placeholder="Description (e.g. Consulting — June)"
              aria-label={`Line ${i + 1} description`}
              className="min-h-[44px] flex-1 rounded border border-gray-300 px-3 text-sm"
            />
            <input
              type="number"
              min="0"
              step="0.5"
              value={line.quantity}
              onChange={(e) => setLine(i, { quantity: e.target.value })}
              aria-label={`Line ${i + 1} quantity`}
              className="min-h-[44px] w-20 rounded border border-gray-300 px-3 text-right text-sm"
            />
            <input
              type="number"
              min="0"
              step="0.01"
              value={line.unitPrice}
              onChange={(e) => setLine(i, { unitPrice: e.target.value })}
              placeholder="0.00"
              aria-label={`Line ${i + 1} unit price`}
              className="min-h-[44px] w-28 rounded border border-gray-300 px-3 text-right text-sm"
            />
            <button
              type="button"
              onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
              disabled={lines.length === 1}
              aria-label={`Remove line ${i + 1}`}
              className="min-h-[44px] rounded px-2 text-sh-gray transition hover:text-red-700 disabled:opacity-30"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setLines((prev) => [...prev, { ...EMPTY_LINE }])}
          className="inline-flex min-h-[44px] items-center gap-1 text-sm text-sh-navy hover:underline"
        >
          <Plus className="h-4 w-4" /> Add line
        </button>
      </div>

      <div className="flex flex-wrap gap-4">
        <div>
          <label htmlFor="invTax" className="mb-1 block text-xs font-medium text-sh-gray">
            Tax %
          </label>
          <input
            id="invTax"
            type="number"
            min="0"
            max="50"
            step="0.01"
            value={taxPct}
            onChange={(e) => setTaxPct(e.target.value)}
            className="min-h-[44px] w-24 rounded border border-gray-300 px-3 text-right text-sm"
          />
        </div>
        <div>
          <label htmlFor="invDue" className="mb-1 block text-xs font-medium text-sh-gray">
            Due date
          </label>
          <input
            id="invDue"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
          />
        </div>
      </div>

      <div>
        <label htmlFor="invNotes" className="mb-1 block text-xs font-medium text-sh-gray">
          Notes (shown on the invoice)
        </label>
        <textarea
          id="invNotes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
        />
      </div>

      <div className="flex items-center justify-between rounded-lg border border-sh-gray/20 bg-sh-linen px-4 py-3">
        <div className="text-sm text-sh-gray">
          Subtotal {money(totals.subtotal)} · Tax {money(totals.tax)}
        </div>
        <div className="text-lg font-semibold text-sh-navy">Total {money(totals.total)}</div>
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="min-h-[44px] rounded-lg bg-sh-navy px-6 py-2 text-sm font-semibold text-white transition hover:bg-sh-blue disabled:opacity-50"
        >
          {saving ? "Saving..." : initial ? "Save Draft" : "Create Draft"}
        </button>
        <Link
          href={initial ? `/app/sales/invoices/${initial.id}` : "/app/sales/invoices"}
          className="inline-flex min-h-[44px] items-center rounded-lg border border-gray-300 px-6 py-2 text-sm text-sh-black transition hover:bg-sh-linen"
        >
          Cancel
        </Link>
      </div>
    </div>
  );
}
