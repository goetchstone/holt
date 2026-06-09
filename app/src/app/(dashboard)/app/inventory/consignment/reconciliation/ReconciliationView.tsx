"use client";

// /app/src/app/(dashboard)/app/inventory/consignment/reconciliation/ReconciliationView.tsx
//
// Consignment Reconciliation body: status stat cards plus on-approval and
// missing-item tables. App Router port of the legacy
// inventory/consignment/reconciliation body (minus MainLayout chrome). Reads the
// shared /api/consignment/stats + /api/consignment/items REST endpoints.

import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import Link from "next/link";
import { toast } from "react-toastify";

interface Stats {
  onFloor: number;
  onApproval: number;
  soldUnpaid: number;
  missing: number;
}

interface ApprovalItem {
  id: string;
  barcode: string;
  quality: string;
  size: string;
  approvalCustomerName: string;
  approvalDate: string;
  approvalNotes: string | null;
}

interface MissingItem {
  id: string;
  barcode: string;
  quality: string;
  size: string;
  storeLocation?: { name: string } | null;
}

function formatDate(d: string | null): string {
  if (!d) return "-";
  return new Date(d).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// The items endpoint returns either a bare array or { items } depending on the
// query — normalize both shapes to an array.
function asItemArray<T>(data: T[] | { items?: T[] }): T[] {
  return Array.isArray(data) ? data : data.items || [];
}

export function ReconciliationView() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [approvalItems, setApprovalItems] = useState<ApprovalItem[]>([]);
  const [missingItems, setMissingItems] = useState<MissingItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, approvalRes, missingRes] = await Promise.all([
        axios.get<Stats>("/api/consignment/stats"),
        axios.get<ApprovalItem[] | { items: ApprovalItem[] }>("/api/consignment/items", {
          params: { status: "ON_APPROVAL", pageSize: 200 },
        }),
        axios.get<MissingItem[] | { items: MissingItem[] }>("/api/consignment/items", {
          params: { status: "MISSING", pageSize: 200 },
        }),
      ]);
      setStats(statsRes.data);
      setApprovalItems(asItemArray(approvalRes.data));
      setMissingItems(asItemArray(missingRes.data));
    } catch {
      toast.error("Failed to load reconciliation data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return <div className="py-8 text-center text-sh-gray font-serif">Loading...</div>;
  }

  return (
    <div className="py-2 space-y-6 font-serif">
      <div className="flex items-center gap-3">
        <Link href="/app/inventory/consignment" className="text-sh-blue hover:underline text-sm">
          Consignment
        </Link>
        <span className="text-sh-gray">/</span>
        <h1 className="text-2xl font-semibold text-sh-blue">Reconciliation</h1>
        <div className="ml-auto">
          <Link
            href="/app/inventory/consignment/receiving-gaps"
            className="text-sm text-sh-blue hover:underline"
          >
            Receiving Gaps (Manager)
          </Link>
        </div>
      </div>

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="On Floor" value={stats.onFloor} color="text-green-700" />
          <StatCard label="On Approval" value={stats.onApproval} color="text-amber-700" />
          <StatCard label="Sold Unpaid" value={stats.soldUnpaid} color="text-blue-700" />
          <StatCard label="Missing" value={stats.missing} color="text-red-700" />
        </div>
      )}

      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md overflow-hidden">
        <div className="px-5 py-4 border-b border-sh-gray/20">
          <h2 className="text-lg font-semibold text-sh-black">On Approval</h2>
        </div>
        {approvalItems.length === 0 ? (
          <div className="px-5 py-6 text-sh-gray text-sm text-center">
            No items currently on approval.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-sh-gray/20 bg-sh-linen">
                  <th className="text-left px-4 py-3 text-sh-gray font-semibold">Barcode</th>
                  <th className="text-left px-4 py-3 text-sh-gray font-semibold">Quality</th>
                  <th className="text-left px-4 py-3 text-sh-gray font-semibold">Size</th>
                  <th className="text-left px-4 py-3 text-sh-gray font-semibold">Customer</th>
                  <th className="text-left px-4 py-3 text-sh-gray font-semibold">Date</th>
                  <th className="text-left px-4 py-3 text-sh-gray font-semibold">Notes</th>
                </tr>
              </thead>
              <tbody>
                {approvalItems.map((item, i) => (
                  <tr
                    key={item.id}
                    className={`border-b border-sh-gray/10 ${i % 2 === 1 ? "bg-sh-stripe" : ""}`}
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/app/inventory/consignment/${item.id}`}
                        className="text-sh-blue hover:underline"
                      >
                        {item.barcode}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-sh-black">{item.quality}</td>
                    <td className="px-4 py-3 text-sh-black">{item.size}</td>
                    <td className="px-4 py-3 text-sh-black">{item.approvalCustomerName}</td>
                    <td className="px-4 py-3 text-sh-black">{formatDate(item.approvalDate)}</td>
                    <td className="px-4 py-3 text-sh-gray">{item.approvalNotes || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md overflow-hidden">
        <div className="px-5 py-4 border-b border-sh-gray/20">
          <h2 className="text-lg font-semibold text-sh-black">Missing Items</h2>
        </div>
        {missingItems.length === 0 ? (
          <div className="px-5 py-6 text-sh-gray text-sm text-center">
            No items currently missing.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-sh-gray/20 bg-sh-linen">
                  <th className="text-left px-4 py-3 text-sh-gray font-semibold">Barcode</th>
                  <th className="text-left px-4 py-3 text-sh-gray font-semibold">Quality</th>
                  <th className="text-left px-4 py-3 text-sh-gray font-semibold">Size</th>
                  <th className="text-left px-4 py-3 text-sh-gray font-semibold">Last Location</th>
                </tr>
              </thead>
              <tbody>
                {missingItems.map((item, i) => (
                  <tr
                    key={item.id}
                    className={`border-b border-sh-gray/10 ${i % 2 === 1 ? "bg-sh-stripe" : ""}`}
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/app/inventory/consignment/${item.id}`}
                        className="text-sh-blue hover:underline"
                      >
                        {item.barcode}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-sh-black">{item.quality}</td>
                    <td className="px-4 py-3 text-sh-black">{item.size}</td>
                    <td className="px-4 py-3 text-sh-black">{item.storeLocation?.name || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: number;
  color: string;
}

function StatCard({ label, value, color }: Readonly<StatCardProps>) {
  return (
    <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-5 text-center">
      <div className={`text-3xl font-semibold ${color}`}>{value}</div>
      <div className="text-sm text-sh-gray mt-1">{label}</div>
    </div>
  );
}
