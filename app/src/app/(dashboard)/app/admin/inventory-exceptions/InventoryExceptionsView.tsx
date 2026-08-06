"use client";

// /app/src/app/(dashboard)/app/admin/inventory-exceptions/InventoryExceptionsView.tsx
//
// The oversell queue. The owner's rule (verbatim): "if the cashier is
// scanning an item to sell it is here, even if inventory is incorrect ...
// the goal is to serve the customer, get the sale first, but also know that
// there is an issue for someone (back office perhaps) to address." This view
// is that "someone" -- every row is a sale that went through with less free
// stock than requested. Mark handled once the shortfall is addressed
// (received a PO, corrected a count, etc).

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import Link from "next/link";
import { getErrorMessage } from "@/lib/toastError";
import type {
  InventoryExceptionRow,
  InventoryExceptionsResponse,
} from "@/pages/api/admin/inventory-exceptions";

export function InventoryExceptionsView() {
  const [rows, setRows] = useState<InventoryExceptionRow[]>([]);
  const [includeResolved, setIncludeResolved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get<InventoryExceptionsResponse>("/api/admin/inventory-exceptions", {
        params: includeResolved ? { includeResolved: "true" } : undefined,
      });
      setRows(res.data.exceptions);
      setError(null);
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Failed to load inventory exceptions."));
    } finally {
      setLoading(false);
    }
  }, [includeResolved]);

  useEffect(() => {
    load();
  }, [load]);

  const resolve = useCallback(
    async (id: number) => {
      setResolvingId(id);
      try {
        await axios.post("/api/admin/inventory-exceptions/resolve", { id });
        await load();
      } catch (err: unknown) {
        setError(getErrorMessage(err, "Failed to mark exception handled."));
      } finally {
        setResolvingId(null);
      }
    },
    [load],
  );

  const openCount = rows.filter((r) => !r.resolvedAt).length;

  return (
    <div className="py-2 font-serif space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-sh-blue">Inventory Exceptions</h1>
        <p className="text-sh-gray text-sm mt-1">
          Sales that went through oversold. Nothing here ever blocked a sale -- it&apos;s a queue of
          shortfalls for back office to address.
        </p>
      </div>

      <div className="bg-white border border-sh-gray/20 rounded-lg shadow-sm p-4 flex items-center gap-4 flex-wrap">
        <span className="text-sm">
          <span className="font-semibold text-sh-black">{openCount}</span>{" "}
          <span className="text-sh-gray">open</span>
          {includeResolved && (
            <>
              <span className="text-sh-gray"> · </span>
              <span className="font-semibold text-sh-black">{rows.length}</span>{" "}
              <span className="text-sh-gray">total</span>
            </>
          )}
        </span>
        <label
          htmlFor="include-resolved"
          className="ml-auto inline-flex items-center gap-2 text-sm text-sh-gray cursor-pointer"
        >
          <input
            id="include-resolved"
            type="checkbox"
            checked={includeResolved}
            onChange={(e) => setIncludeResolved(e.target.checked)}
            className="w-4 h-4"
          />
          <span>Include handled</span>
        </label>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm p-3 rounded">
          {error}
        </div>
      )}

      {loading && rows.length === 0 && <p className="text-sh-gray text-center py-8">Loading…</p>}
      {!loading && rows.length === 0 && (
        <p className="text-sh-gray text-center py-8">
          {includeResolved ? "No inventory exceptions." : "No open inventory exceptions."}
        </p>
      )}
      {rows.length > 0 && (
        <div className="bg-white border border-sh-gray/20 rounded-lg shadow-sm overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-sh-linen border-b border-sh-gray/20">
                <th className="text-left p-3 font-semibold text-sh-black">Order</th>
                <th className="text-left p-3 font-semibold text-sh-black">Product</th>
                <th className="text-left p-3 font-semibold text-sh-black">Store</th>
                <th className="text-right p-3 font-semibold text-sh-black">Requested</th>
                <th className="text-right p-3 font-semibold text-sh-black">Allocated</th>
                <th className="text-right p-3 font-semibold text-sh-black">Shortfall</th>
                <th className="text-left p-3 font-semibold text-sh-black">Occurred</th>
                <th className="text-left p-3 font-semibold text-sh-black">Status</th>
                <th className="text-left p-3 font-semibold text-sh-black" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className={`border-b border-sh-gray/10 ${row.resolvedAt ? "opacity-60" : "hover:bg-sh-stripe"}`}
                >
                  <td className="p-3 text-sh-black font-medium">
                    <Link
                      href={`/app/sales/orders/${row.salesOrderId}`}
                      className="text-sh-blue hover:underline"
                    >
                      {row.orderno}
                    </Link>
                  </td>
                  <td className="p-3 text-sh-black">
                    {row.productName}
                    <span className="text-sh-gray text-xs ml-1">({row.partNo})</span>
                  </td>
                  <td className="p-3 text-sh-gray">{row.storeLocationName}</td>
                  <td className="p-3 text-right text-sh-gray">{row.requested}</td>
                  <td className="p-3 text-right text-sh-gray">{row.allocated}</td>
                  <td className="p-3 text-right font-semibold text-red-700">{row.shortfall}</td>
                  <td className="p-3 text-sh-gray text-xs">
                    {new Date(row.occurredAt).toLocaleString()}
                  </td>
                  <td className="p-3">
                    {row.resolvedAt ? (
                      <span className="text-xs text-green-700">
                        Handled {new Date(row.resolvedAt).toLocaleDateString()}
                        {row.resolvedBy ? ` by ${row.resolvedBy}` : ""}
                      </span>
                    ) : (
                      <span className="text-xs uppercase tracking-wide text-amber-700">Open</span>
                    )}
                  </td>
                  <td className="p-3">
                    {!row.resolvedAt && (
                      <button
                        type="button"
                        onClick={() => resolve(row.id)}
                        disabled={resolvingId === row.id}
                        className="text-xs px-2 py-1 rounded border border-sh-gray/30 text-sh-black hover:bg-sh-linen disabled:opacity-50"
                      >
                        {resolvingId === row.id ? "Marking…" : "Mark handled"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
