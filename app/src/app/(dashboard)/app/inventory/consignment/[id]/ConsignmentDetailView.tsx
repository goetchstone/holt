"use client";

// /app/src/app/(dashboard)/app/inventory/consignment/[id]/ConsignmentDetailView.tsx
//
// Consignment item detail body: details/pricing/location/status cards plus
// status-transition actions (approval, sold, return, missing). App Router port
// of the legacy inventory/consignment/[id] body (minus MainLayout chrome). The
// id arrives as a prop from the server page. Reads + mutates the shared
// /api/consignment/items/:id REST endpoints; money uses the tenant formatter.

import { useState, useEffect, useCallback, type ReactNode } from "react";
import Link from "next/link";
import axios from "axios";
import { toast } from "react-toastify";
import { Dialog, DialogBackdrop, DialogPanel } from "@headlessui/react";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";

interface ConsignmentItem {
  id: string;
  barcode: string;
  rugNumber: string;
  customerNumber: string;
  quality: string;
  size: string;
  year: number | null;
  cost: number;
  anchorPrice: number;
  retailPrice: number;
  sellingPrice: number | null;
  status: string;
  saleDate: string | null;
  saleCustomerName: string | null;
  saleTransactionId: string | null;
  approvalCustomerName: string | null;
  approvalDate: string | null;
  approvalNotes: string | null;
  paymentBatchDate: string | null;
  paymentCheckNumber: string | null;
  vendor?: { name: string } | null;
  storeLocation?: { name: string } | null;
  salesOrder?: { id: string; orderNumber: string } | null;
}

const STATUS_BADGE: Record<string, string> = {
  ON_FLOOR: "bg-green-100 text-green-800",
  ON_APPROVAL: "bg-amber-100 text-amber-800",
  SOLD: "bg-blue-100 text-blue-800",
  RETURNED_VENDOR: "bg-gray-100 text-gray-600",
  MISSING: "bg-red-100 text-red-800",
  PAID: "bg-sh-gold/20 text-sh-gold",
};

const STATUS_LABELS: Record<string, string> = {
  ON_FLOOR: "On Floor",
  ON_APPROVAL: "On Approval",
  SOLD: "Sold",
  RETURNED_VENDOR: "Returned",
  MISSING: "Missing",
  PAID: "Paid",
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] || status;
}

function badgeClass(status: string): string {
  return STATUS_BADGE[status] || "bg-gray-100 text-gray-600";
}

function formatDate(d: string | null): string {
  if (!d) return "-";
  return new Date(d).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function ConsignmentDetailView({ id }: Readonly<{ id: string }>) {
  const fmt = useMoneyFormatter();

  const [item, setItem] = useState<ConsignmentItem | null>(null);
  const [loading, setLoading] = useState(true);

  const [approvalOpen, setApprovalOpen] = useState(false);
  const [approvalCustomer, setApprovalCustomer] = useState("");
  const [approvalNotes, setApprovalNotes] = useState("");

  const [soldOpen, setSoldOpen] = useState(false);
  const [soldCustomer, setSoldCustomer] = useState("");
  const [soldDate, setSoldDate] = useState("");

  const [submitting, setSubmitting] = useState(false);

  const itemPath = `/api/consignment/items/${encodeURIComponent(id)}`;

  const loadItem = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get<ConsignmentItem>(itemPath);
      setItem(res.data);
    } catch {
      toast.error("Failed to load consignment item.");
    } finally {
      setLoading(false);
    }
  }, [itemPath]);

  useEffect(() => {
    loadItem();
  }, [loadItem]);

  async function markAction(action: string, body?: Record<string, string>) {
    setSubmitting(true);
    try {
      await axios.post(`${itemPath}/${encodeURIComponent(action)}`, body || {});
      toast.success("Item updated.");
      const res = await axios.get<ConsignmentItem>(itemPath);
      setItem(res.data);
      setApprovalOpen(false);
      setSoldOpen(false);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to update item."));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <div className="py-8 text-center text-sh-gray font-serif">Loading...</div>;
  }

  if (!item) {
    return <div className="py-8 text-center text-sh-gray font-serif">Item not found.</div>;
  }

  return (
    <div className="py-2 space-y-6 font-serif">
      <div className="flex items-center gap-3">
        <Link href="/app/inventory/consignment" className="text-sh-blue hover:underline text-sm">
          Consignment
        </Link>
        <span className="text-sh-gray">/</span>
        <h1 className="text-2xl font-semibold text-sh-blue">{item.barcode}</h1>
        <span
          className={`inline-block px-3 py-1 rounded-full text-xs font-semibold ${badgeClass(
            item.status,
          )}`}
        >
          {statusLabel(item.status)}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <InfoCard title="Details">
          <Row label="Quality" value={item.quality} />
          <Row label="Rug Number" value={item.rugNumber} />
          <Row label="Customer Number" value={item.customerNumber} />
          <Row label="Size" value={item.size} />
          <Row label="Year" value={item.year != null ? String(item.year) : "-"} />
          <Row label="Vendor" value={item.vendor?.name || "-"} />
        </InfoCard>

        <InfoCard title="Pricing">
          <Row label="Cost" value={fmt(item.cost)} />
          <Row label="Anchor Price" value={fmt(item.anchorPrice)} />
          <Row label="Retail Price" value={fmt(item.retailPrice)} />
          {item.sellingPrice != null && (
            <Row label="Selling Price" value={fmt(item.sellingPrice)} />
          )}
        </InfoCard>

        {item.storeLocation && (
          <InfoCard title="Location">
            <Row label="Store" value={item.storeLocation.name} />
          </InfoCard>
        )}

        {item.status === "SOLD" && (
          <InfoCard title="Sale Info">
            <Row label="Sale Date" value={formatDate(item.saleDate)} />
            <Row label="Customer" value={item.saleCustomerName || "-"} />
            <Row label="Transaction ID" value={item.saleTransactionId || "-"} />
            {item.salesOrder && <Row label="Order" value={item.salesOrder.orderNumber} />}
          </InfoCard>
        )}

        {item.status === "PAID" && (
          <InfoCard title="Payment Info">
            <Row label="Batch Date" value={formatDate(item.paymentBatchDate)} />
            <Row label="Check Number" value={item.paymentCheckNumber || "-"} />
          </InfoCard>
        )}

        {item.status === "ON_APPROVAL" && (
          <InfoCard title="Approval Info">
            <Row label="Customer" value={item.approvalCustomerName || "-"} />
            <Row label="Date" value={formatDate(item.approvalDate)} />
            <Row label="Notes" value={item.approvalNotes || "-"} />
          </InfoCard>
        )}
      </div>

      <StatusActions
        item={item}
        submitting={submitting}
        onMark={markAction}
        onOpenApproval={() => setApprovalOpen(true)}
        onOpenSold={() => setSoldOpen(true)}
      />

      {approvalOpen && (
        <ModalShell title="Send on Approval" onClose={() => setApprovalOpen(false)}>
          <div className="space-y-3">
            <div>
              <label htmlFor="approval-customer" className="block text-xs text-sh-gray mb-1">
                Customer Name
              </label>
              <input
                id="approval-customer"
                type="text"
                value={approvalCustomer}
                onChange={(e) => setApprovalCustomer(e.target.value)}
                className="border border-sh-gray/40 rounded-lg px-3 min-h-[44px] w-full font-serif text-sh-black"
              />
            </div>
            <div>
              <label htmlFor="approval-notes" className="block text-xs text-sh-gray mb-1">
                Notes
              </label>
              <textarea
                id="approval-notes"
                value={approvalNotes}
                onChange={(e) => setApprovalNotes(e.target.value)}
                rows={3}
                className="border border-sh-gray/40 rounded-lg px-3 py-2 w-full font-serif text-sh-black"
              />
            </div>
            <Button
              onClick={() =>
                markAction("mark-approval", {
                  customerName: approvalCustomer,
                  notes: approvalNotes,
                })
              }
              disabled={submitting || !approvalCustomer}
              className="min-h-[44px]"
            >
              Confirm
            </Button>
          </div>
        </ModalShell>
      )}

      {soldOpen && (
        <ModalShell title="Mark as Sold" onClose={() => setSoldOpen(false)}>
          <div className="space-y-3">
            <div>
              <label htmlFor="sold-customer" className="block text-xs text-sh-gray mb-1">
                Customer Name
              </label>
              <input
                id="sold-customer"
                type="text"
                value={soldCustomer}
                onChange={(e) => setSoldCustomer(e.target.value)}
                className="border border-sh-gray/40 rounded-lg px-3 min-h-[44px] w-full font-serif text-sh-black"
              />
            </div>
            <div>
              <label htmlFor="sold-date" className="block text-xs text-sh-gray mb-1">
                Sale Date
              </label>
              <input
                id="sold-date"
                type="date"
                value={soldDate}
                onChange={(e) => setSoldDate(e.target.value)}
                className="border border-sh-gray/40 rounded-lg px-3 min-h-[44px] w-full font-serif text-sh-black"
              />
            </div>
            <Button
              onClick={() =>
                markAction("mark-sold", {
                  customerName: soldCustomer,
                  saleDate: soldDate,
                })
              }
              disabled={submitting || !soldCustomer || !soldDate}
              className="min-h-[44px]"
            >
              Confirm Sale
            </Button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}

interface StatusActionsProps {
  item: ConsignmentItem;
  submitting: boolean;
  onMark: (action: string) => void;
  onOpenApproval: () => void;
  onOpenSold: () => void;
}

function StatusActions({
  item,
  submitting,
  onMark,
  onOpenApproval,
  onOpenSold,
}: Readonly<StatusActionsProps>) {
  return (
    <div className="flex flex-wrap gap-3">
      {item.status === "ON_FLOOR" && (
        <>
          <Button onClick={onOpenApproval} className="min-h-[44px]">
            Send on Approval
          </Button>
          <Button onClick={onOpenSold} className="min-h-[44px]">
            Mark Sold
          </Button>
          <Button
            variant="outline"
            onClick={() => onMark("mark-returned")}
            disabled={submitting}
            className="min-h-[44px]"
          >
            Return to Vendor
          </Button>
          <Button
            variant="outline"
            onClick={() => onMark("mark-missing")}
            disabled={submitting}
            className="min-h-[44px]"
          >
            Mark Missing
          </Button>
        </>
      )}
      {item.status === "ON_APPROVAL" && (
        <>
          <Button
            onClick={() => onMark("return-to-floor")}
            disabled={submitting}
            className="min-h-[44px]"
          >
            Return to Floor
          </Button>
          <Button onClick={onOpenSold} className="min-h-[44px]">
            Mark Sold
          </Button>
        </>
      )}
      {item.status === "SOLD" && item.paymentBatchDate && (
        <Link href="/app/inventory/consignment/payments">
          <Button variant="outline" className="min-h-[44px]">
            View Payment Batch
          </Button>
        </Link>
      )}
      {item.status === "MISSING" && (
        <Button
          onClick={() => onMark("return-to-floor")}
          disabled={submitting}
          className="min-h-[44px]"
        >
          Found - Return to Floor
        </Button>
      )}
    </div>
  );
}

function InfoCard({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-5">
      <h2 className="text-lg font-semibold text-sh-black mb-3">{title}</h2>
      <dl className="space-y-2">{children}</dl>
    </div>
  );
}

function Row({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="flex justify-between text-sm">
      <dt className="text-sh-gray">{label}</dt>
      <dd className="text-sh-black font-medium">{value}</dd>
    </div>
  );
}

function ModalShell({
  title,
  onClose,
  children,
}: Readonly<{ title: string; onClose: () => void; children: ReactNode }>) {
  return (
    <Dialog open onClose={onClose} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-sh-black/40" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="relative bg-white rounded-lg shadow-xl p-6 w-full max-w-md">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-sh-black">{title}</h3>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-sh-gray hover:text-sh-black min-h-[44px] min-w-[44px] flex items-center justify-center"
            >
              X
            </button>
          </div>
          {children}
        </DialogPanel>
      </div>
    </Dialog>
  );
}
