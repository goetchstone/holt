"use client";

// /app/src/app/(dashboard)/app/warehouse/overview/WarehouseOverviewView.tsx
//
// Warehouse overview body (summary cards + store-location grid). App Router port
// of the legacy pages/warehouse/overview.tsx body (minus MainLayout chrome,
// which comes from the (dashboard) layout). Reads the shared
// /api/warehouse/dashboard/summary REST endpoint.

import { useState, useEffect } from "react";
import Link from "next/link";
import axios from "axios";
import { Loader2 } from "lucide-react";

interface StockLocationEntry {
  name: string;
  quantity: number;
}

interface LocationSummary {
  id: number;
  name: string;
  totalItems: number;
  stockLocationBreakdown: Record<string, StockLocationEntry>;
}

interface DashboardSummary {
  locations: LocationSummary[];
  transfersInTransit: number;
  pendingDispatch: number;
}

export function WarehouseOverviewView() {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await axios.get<DashboardSummary>("/api/warehouse/dashboard/summary");
        setData(res.data);
      } catch {
        // Silent fail -- page shows empty state
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const totalInventory = data?.locations.reduce((sum, loc) => sum + loc.totalItems, 0) ?? 0;

  if (loading) {
    return (
      <div className="py-2 font-serif flex items-center justify-center min-h-[300px]">
        <Loader2 className="h-8 w-8 animate-spin text-sh-gray" />
      </div>
    );
  }

  return (
    <div className="py-2 space-y-6 font-serif">
      {/* Breadcrumb */}
      <nav className="text-sm text-sh-gray">
        <Link href="/app/warehouse" className="hover:text-sh-blue transition">
          Warehouse
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">Overview</span>
      </nav>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-sh-gray/15 p-4 text-center">
          <p className="text-sm text-sh-gray mb-1">Total Inventory</p>
          <p className="text-3xl font-semibold text-sh-black">{totalInventory.toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-xl border border-sh-gray/15 p-4 text-center">
          <p className="text-sm text-sh-gray mb-1">Transfers In Transit</p>
          <p className="text-3xl font-semibold text-sh-black">{data?.transfersInTransit ?? 0}</p>
        </div>
        <div className="bg-white rounded-xl border border-sh-gray/15 p-4 text-center">
          <p className="text-sm text-sh-gray mb-1">Pending Dispatch</p>
          <p className="text-3xl font-semibold text-sh-black">{data?.pendingDispatch ?? 0}</p>
        </div>
      </div>

      {/* Store location grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {data?.locations.map((location) => {
          const stockEntries = Object.values(location.stockLocationBreakdown);
          return (
            <Link
              key={location.id}
              href={`/app/warehouse/positions?store=${location.id}`}
              className="bg-white rounded-xl border border-sh-gray/15 p-5 hover:shadow-lg transition cursor-pointer block min-h-[44px]"
            >
              <p className="text-lg font-semibold text-sh-blue">{location.name}</p>
              <p className="text-2xl font-semibold text-sh-black mt-1">
                {location.totalItems.toLocaleString()}
                <span className="text-sm font-normal text-sh-gray ml-2">items</span>
              </p>
              {stockEntries.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {stockEntries.map((entry) => (
                    <li key={entry.name} className="flex justify-between text-sm text-sh-gray">
                      <span>{entry.name}</span>
                      <span className="tabular-nums">{entry.quantity.toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
