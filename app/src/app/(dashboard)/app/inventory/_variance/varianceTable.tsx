"use client";

// /app/src/app/(dashboard)/app/inventory/_variance/varianceTable.tsx
//
// Shared variance-table building blocks for the General + Apparel variance
// reports (App Router ports of pages/inventory/variance-report.tsx and
// variance-apparel.tsx, which were byte-for-byte duplicates of this logic).
// Leading-underscore folder is ignored by Next.js routing. Keeps the
// VarianceRecord shape, the reconcile POST, the variance cell styling, and the
// column builder in one place so the two report views never drift.

import axios from "axios";
import { toast } from "react-toastify";
import Link from "next/link";
import { Barcode, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Column } from "@/components/table/PaginatedTable";
import { getErrorMessage } from "@/lib/toastError";

export interface VarianceRecord {
  externalId: number;
  productName: string;
  productNumber: string;
  barcode: string;
  expected: number;
  counted: number;
  variance: number;
  isPotentialTransfer: boolean;
}

export interface SortConfig {
  key: string;
  direction: "asc" | "desc";
}

export type ReconcileAction = "found" | "confirm" | "correct";

export function varianceCellClass(variance: number): string {
  if (variance < 0) return "bg-red-100 text-red-800 font-bold";
  if (variance > 0) return "bg-green-100 text-green-800 font-bold";
  return "";
}

/**
 * Reconcile one variance row: for the "correct" action prompts for a new count
 * (aborting on cancel / invalid input), then POSTs and re-fetches via `onDone`.
 * Identical flow for both variance reports, so it lives here.
 */
export async function reconcileVariance(args: {
  item: VarianceRecord;
  location: string;
  action: ReconcileAction;
  onDone: () => void;
}): Promise<void> {
  const { item, location, action, onDone } = args;

  let correctedCount: number | undefined;
  if (action === "correct") {
    const newCountStr = globalThis.prompt(
      `Change the physical count for ${item.productName}:`,
      item.counted.toString(),
    );
    if (newCountStr === null) return;
    correctedCount = Number.parseInt(newCountStr, 10);
    if (Number.isNaN(correctedCount)) {
      toast.error("Invalid number entered.");
      return;
    }
  }

  try {
    await axios.post("/api/inventory/reconcile", {
      item: { ...item, location },
      action,
      correctedCount,
    });
    toast.success(`'${item.productName}' reconciled.`);
    onDone();
  } catch (err: unknown) {
    toast.error(getErrorMessage(err, "Failed to save reconciliation."));
  }
}

function ProductNameCell({
  row,
  productHref,
}: Readonly<{ row: VarianceRecord; productHref: (row: VarianceRecord) => string }>) {
  return (
    <div className="flex items-center gap-2">
      <Link
        href={productHref(row)}
        className="hover:underline text-sh-blue truncate"
        title={row.productName}
      >
        {row.productName}
      </Link>
      {row.barcode && row.barcode !== "N/A" && (
        <button
          type="button"
          onClick={() => toast.info(`Barcode: ${row.barcode}`)}
          className="cursor-pointer"
        >
          <Barcode className="w-5 h-5 text-gray-400 hover:text-gray-600" />
        </button>
      )}
      {row.isPotentialTransfer && (
        <div title="This item is an addition here, but is marked as missing in another location.">
          <AlertTriangle className="w-5 h-5 text-amber-500" />
        </div>
      )}
    </div>
  );
}

function VarianceActionsCell({
  row,
  onReconcile,
}: Readonly<{
  row: VarianceRecord;
  onReconcile: (row: VarianceRecord, action: ReconcileAction) => void;
}>) {
  return (
    <div className="flex space-x-2 items-center justify-start min-w-[250px] h-full">
      {row.variance < 0 && (
        <Button variant="outline" onClick={() => onReconcile(row, "found")}>
          Found
        </Button>
      )}
      <Button variant="outline" onClick={() => onReconcile(row, "confirm")}>
        Confirm
      </Button>
      <Button variant="outline" onClick={() => onReconcile(row, "correct")}>
        Change
      </Button>
    </div>
  );
}

/**
 * Build the column set shared by both variance reports. `productHref` lets each
 * report point the product-name link at the right place (the apparel report
 * appends a returnUrl); `onReconcile` wires the row action buttons.
 */
export function buildVarianceColumns(args: {
  productHref: (row: VarianceRecord) => string;
  onReconcile: (row: VarianceRecord, action: ReconcileAction) => void;
}): Column[] {
  const { productHref, onReconcile } = args;
  return [
    {
      key: "productName",
      label: "Product Name",
      accessor: "productName",
      sortable: true,
      render: (row: VarianceRecord) => <ProductNameCell row={row} productHref={productHref} />,
    },
    { key: "productNumber", label: "Product #", accessor: "productNumber", sortable: true },
    {
      key: "expected",
      label: "Expected",
      accessor: "expected",
      sortable: true,
      align: "center" as const,
      render: (row: VarianceRecord) => <div className="text-center">{row.expected}</div>,
    },
    {
      key: "counted",
      label: "Counted",
      accessor: "counted",
      sortable: true,
      align: "center" as const,
      render: (row: VarianceRecord) => <div className="text-center">{row.counted}</div>,
    },
    {
      key: "variance",
      label: "Variance",
      accessor: "variance",
      sortable: true,
      align: "center" as const,
      render: (row: VarianceRecord) => (
        <div className={`text-center p-1 rounded ${varianceCellClass(row.variance)}`}>
          {row.variance > 0 ? `+${row.variance}` : row.variance}
        </div>
      ),
    },
    {
      key: "actions",
      label: "Actions",
      accessor: "id",
      sortable: false,
      render: (row: VarianceRecord) => <VarianceActionsCell row={row} onReconcile={onReconcile} />,
    },
  ];
}
