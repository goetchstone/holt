"use client";

// /app/src/app/(dashboard)/app/admin/diagnostics/relink-line-items/RelinkLineItemsView.tsx
//
// Relink Order Line Items body. App Router port of the legacy
// admin/diagnostics/relink-line-items body (minus MainLayout chrome). Links
// historical order line items to product records by exact part number via the
// shared /api/admin/relink-line-items REST endpoint.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import Link from "next/link";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";

interface Status {
  unlinked: number;
  totalActive: number;
  percentUnlinked: number;
}

interface RelinkResult {
  updated: number;
  remainingUnlinked: number;
  partNosProcessed: number;
}

export function RelinkLineItemsView() {
  const [status, setStatus] = useState<Status | null>(null);
  const [running, setRunning] = useState(false);
  const [lastResult, setLastResult] = useState<RelinkResult | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await axios.get<Status>("/api/admin/relink-line-items");
      setStatus(res.data);
    } catch {
      toast.error("Failed to load status.");
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleRelink = useCallback(async () => {
    setRunning(true);
    try {
      const res = await axios.post<RelinkResult>("/api/admin/relink-line-items");
      setLastResult(res.data);
      toast.success(`Linked ${res.data.updated.toLocaleString()} line items.`);
      await loadStatus();
    } catch {
      toast.error("Relink failed. Check server logs.");
    } finally {
      setRunning(false);
    }
  }, [loadStatus]);

  return (
    <div className="py-2 space-y-6 font-serif">
      <div className="flex items-center gap-3">
        <Link href="/app/admin" className="text-sh-blue hover:underline text-sm">
          Admin
        </Link>
        <span className="text-sh-gray">/</span>
        <h1 className="text-2xl font-semibold text-sh-blue">Relink Order Line Items</h1>
      </div>

      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6 space-y-5">
        <p className="text-sm text-sh-gray leading-relaxed">
          Some historical order line items are not linked to a product record (Product Number
          matches but the foreign key is NULL). They appear as <em>Uncategorized</em> on reports.
          This tool matches those line items to products by exact part number and sets the link.
          Already linked lines are never touched.
        </p>

        <div className="grid grid-cols-2 gap-4">
          <div className="p-4 rounded-lg border border-sh-gray/20 bg-sh-linen">
            <p className="text-xs text-sh-gray uppercase tracking-wide">Unlinked lines</p>
            <p className="text-3xl font-semibold text-sh-black mt-1">
              {status ? status.unlinked.toLocaleString() : "…"}
            </p>
            {status && (
              <p className="text-xs text-sh-gray mt-1">
                {status.percentUnlinked.toFixed(2)}% of active lines
              </p>
            )}
          </div>
          <div className="p-4 rounded-lg border border-sh-gray/20 bg-sh-linen">
            <p className="text-xs text-sh-gray uppercase tracking-wide">Active lines total</p>
            <p className="text-3xl font-semibold text-sh-black mt-1">
              {status ? status.totalActive.toLocaleString() : "…"}
            </p>
          </div>
        </div>

        {lastResult && (
          <div className="p-4 rounded-lg border border-green-200 bg-green-50">
            <p className="text-sm font-semibold text-green-800">Last run result</p>
            <p className="text-sm text-green-700 mt-1">
              Linked <strong>{lastResult.updated.toLocaleString()}</strong> line items.{" "}
              <strong>{lastResult.remainingUnlinked.toLocaleString()}</strong> remain unlinked (no
              matching product number).
            </p>
          </div>
        )}

        <div className="flex items-center gap-3 pt-2">
          <Button
            onClick={handleRelink}
            disabled={running || (status?.unlinked ?? 0) === 0}
            className="min-h-[44px] px-6"
          >
            {running ? "Running…" : "Run Relink"}
          </Button>
          <button
            onClick={loadStatus}
            className="text-sm text-sh-blue hover:underline"
            disabled={running}
          >
            Refresh status
          </button>
        </div>

        <p className="text-xs text-sh-gray mt-4">
          This also runs automatically after every product import and every Marjan manifest import,
          scoped to the just-imported part numbers. Use this page when you have a one-off cleanup or
          want to sweep everything.
        </p>
      </div>
    </div>
  );
}
