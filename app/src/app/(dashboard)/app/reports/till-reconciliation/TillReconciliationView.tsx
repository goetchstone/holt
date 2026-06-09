"use client";

// /app/src/app/(dashboard)/app/reports/till-reconciliation/TillReconciliationView.tsx
//
// Till reconciliation list (expected vs actual cash per till). Reads the shared
// /api/tills + /api/warehouse/locations endpoints (used outside the reports
// domain, so they stay REST). Any signed-in user; the page gated server-side.

import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

interface StoreLocation {
  id: number;
  name: string;
}

interface TillRow {
  id: number;
  status: string;
  openedAt: string;
  closedAt: string | null;
  openingCash: number;
  expectedCash: number | null;
  actualCash: number | null;
  variance: number | null;
  register: { name: string; storeLocation: { name: string } };
  openedBy: { displayName: string };
  closedBy: { displayName: string } | null;
}

const STATUS_STYLES: Record<string, string> = {
  OPEN: "bg-green-50 text-green-700",
  CLOSED: "bg-yellow-50 text-yellow-700",
  RECONCILED: "bg-blue-50 text-blue-700",
};

export function TillReconciliationView() {
  const money = useMoneyFormatter();
  const fmt = (n: number | null | undefined) => (n == null ? "--" : money(n));

  const [tills, setTills] = useState<TillRow[]>([]);
  const [storeLocations, setStoreLocations] = useState<StoreLocation[]>([]);
  const [loading, setLoading] = useState(false);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [storeLocationId, setStoreLocationId] = useState("");

  useEffect(() => {
    axios
      .get("/api/warehouse/locations")
      .then((res) => setStoreLocations(res.data.locations))
      .catch(() => toast.error("Failed to load store locations"));
  }, []);

  const fetchTills = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", "50");
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      if (storeLocationId) params.set("storeLocationId", storeLocationId);
      const res = await axios.get(`/api/tills?${params.toString()}`);
      setTills(res.data.tills);
    } catch {
      toast.error("Failed to load tills");
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, storeLocationId]);

  useEffect(() => {
    fetchTills();
  }, [fetchTills]);

  const fmtDate = (d: string) => new Date(d).toLocaleDateString();

  const totals = tills.reduce(
    (acc, t) => {
      acc.expected += t.expectedCash || 0;
      acc.actual += t.actualCash || 0;
      acc.variance += t.variance || 0;
      return acc;
    },
    { expected: 0, actual: 0, variance: 0 },
  );

  return (
    <div className="space-y-6 py-2 font-serif">
      <h1 className="text-2xl font-semibold text-sh-blue">Till Reconciliation</h1>

      <div className="rounded-lg border border-sh-gray/20 bg-white p-4 shadow-md">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label htmlFor="from" className="mb-1 block text-sm text-sh-gray">
              From
            </label>
            <input
              id="from"
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="rounded border border-sh-gray/30 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="to" className="mb-1 block text-sm text-sh-gray">
              To
            </label>
            <input
              id="to"
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="rounded border border-sh-gray/30 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="store" className="mb-1 block text-sm text-sh-gray">
              Store
            </label>
            <select
              id="store"
              value={storeLocationId}
              onChange={(e) => setStoreLocationId(e.target.value)}
              className="rounded border border-sh-gray/30 px-3 py-2 text-sm"
            >
              <option value="">All Stores</option>
              {storeLocations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name}
                </option>
              ))}
            </select>
          </div>
          <Button variant="outline" size="sm" onClick={fetchTills}>
            Apply
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="text-sh-gray">Loading...</p>
      ) : tills.length === 0 ? (
        <p className="py-8 text-center text-sh-gray">No tills found for the selected filters.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-sh-gray/20 bg-white shadow-md">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-sh-gray/10 text-left text-sh-gray">
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 font-medium">Register</th>
                  <th className="px-4 py-2 font-medium">Store</th>
                  <th className="px-4 py-2 font-medium">Opened By</th>
                  <th className="px-4 py-2 font-medium">Closed By</th>
                  <th className="px-4 py-2 text-right font-medium">Expected</th>
                  <th className="px-4 py-2 text-right font-medium">Actual</th>
                  <th className="px-4 py-2 text-right font-medium">Variance</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {tills.map((t) => (
                  <tr key={t.id} className="border-b border-sh-gray/5 hover:bg-sh-stripe/50">
                    <td className="px-4 py-2 text-sh-black">{fmtDate(t.openedAt)}</td>
                    <td className="px-4 py-2 text-sh-black">{t.register.name}</td>
                    <td className="px-4 py-2 text-sh-gray">{t.register.storeLocation.name}</td>
                    <td className="px-4 py-2 text-sh-gray">{t.openedBy.displayName}</td>
                    <td className="px-4 py-2 text-sh-gray">{t.closedBy?.displayName || "--"}</td>
                    <td className="px-4 py-2 text-right text-sh-black">{fmt(t.expectedCash)}</td>
                    <td className="px-4 py-2 text-right text-sh-black">{fmt(t.actualCash)}</td>
                    <td
                      className={`px-4 py-2 text-right font-medium ${
                        t.variance == null
                          ? "text-sh-gray"
                          : t.variance === 0
                            ? "text-green-600"
                            : "text-red-600"
                      }`}
                    >
                      {fmt(t.variance)}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLES[t.status] || "bg-sh-gray/10 text-sh-gray"}`}
                      >
                        {t.status}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <Link
                        href={`/app/sales/till/${t.id}`}
                        className="text-xs text-sh-blue hover:underline"
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-sh-gray/20 bg-sh-stripe/30">
                  <td className="px-4 py-3 font-semibold text-sh-black" colSpan={5}>
                    Totals
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-sh-black">
                    {fmt(totals.expected)}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-sh-black">
                    {fmt(totals.actual)}
                  </td>
                  <td
                    className={`px-4 py-3 text-right font-semibold ${totals.variance === 0 ? "text-green-600" : "text-red-600"}`}
                  >
                    {fmt(totals.variance)}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
