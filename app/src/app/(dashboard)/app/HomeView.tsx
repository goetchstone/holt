"use client";

// /app/src/app/(dashboard)/app/HomeView.tsx
//
// Manager-facing dashboard body: per-store traffic + sales cards and the
// designer up-board rotation. App Router port of the pages/index.tsx body (minus
// MainLayout, which the (dashboard) layout supplies). Store locations come from
// the database (Admin > Setup > Stores), never a hardcoded list. Reads the shared
// /api/axper/traffic + /api/dashboard/sales-summary REST endpoints.

import { useEffect, useState, useMemo, useCallback } from "react";
import { format, subYears } from "date-fns";
import { ArrowUp, ArrowDown } from "lucide-react";
import UpBoard from "@/components/dashboard/UpBoard";
import { getStoreDisplayName, getStoreLocationName } from "@/lib/storeColors";
import { useStoreLocations } from "@/hooks/useStoreLocations";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

interface UpBoardStore {
  store: string;
  label: string;
}

interface TrafficRow {
  store_number?: string;
  store_name?: string;
  local_time?: string;
  entries: number;
  exits: number;
}

interface StoreSales {
  location: string;
  items: number;
  netSales: number;
  tax: number;
  total: number;
  lyItems: number;
  lyNetSales: number;
  lyTax: number;
  lyTotal: number;
}

const REFRESH_MS = 900000;

export function HomeView() {
  const formatMoney = useMoneyFormatter();
  const formatCurrency = useCallback(
    (value: number): string => formatMoney(value, { whole: true }),
    [formatMoney],
  );

  const [todayTraffic, setTodayTraffic] = useState<TrafficRow[]>([]);
  const [lastYearTraffic, setLastYearTraffic] = useState<TrafficRow[]>([]);
  const [salesByStore, setSalesByStore] = useState<Record<string, StoreSales>>({});

  // Configured store locations come from the database (Admin > Setup > Stores),
  // never a hardcoded list -- each deployment defines its own.
  const { stores: dbStores } = useStoreLocations({ type: "STORE" });

  const upBoardStores: UpBoardStore[] = useMemo(
    () => dbStores.map((s) => ({ store: s.name, label: s.name })),
    [dbStores],
  );

  const allStores = useMemo(() => {
    const names = new Set<string>(dbStores.map((s) => s.name));
    [todayTraffic, lastYearTraffic].forEach((dataset) => {
      (dataset || []).forEach((row) => {
        if (row?.store_name) names.add(row.store_name);
      });
    });
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [todayTraffic, lastYearTraffic, dbStores]);

  const getTrafficData = useCallback(
    async (dateFrom: string, dateTo: string): Promise<TrafficRow[]> => {
      try {
        const response = await fetch(`/api/axper/traffic?dateFrom=${dateFrom}&dateTo=${dateTo}`);
        const text = await response.text();
        if (text.startsWith("store_number,store_name,local_time,entries,exits")) {
          return [];
        }
        const data = JSON.parse(text);
        if (data.error) throw new Error(data.error);
        return data;
      } catch {
        return [];
      }
    },
    [],
  );

  useEffect(() => {
    const now = new Date();
    const today = format(now, "yyyy-MM-dd");
    const lastYearSameDay = format(subYears(now, 1), "yyyy-MM-dd");

    async function fetchData() {
      setTodayTraffic(await getTrafficData(today, today));
      setLastYearTraffic(await getTrafficData(lastYearSameDay, lastYearSameDay));
    }

    fetchData();
    const interval = setInterval(fetchData, REFRESH_MS);
    return () => clearInterval(interval);
  }, [getTrafficData]);

  useEffect(() => {
    async function fetchSales() {
      try {
        const res = await fetch("/api/dashboard/sales-summary");
        if (!res.ok) return;
        const data: { stores: StoreSales[] } = await res.json();
        const map: Record<string, StoreSales> = {};
        for (const store of data.stores) {
          map[store.location] = store;
        }
        setSalesByStore(map);
      } catch {
        // Sales data is supplementary -- silently fail
      }
    }

    fetchSales();
    const interval = setInterval(fetchSales, REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  const todayByStore = useMemo(() => {
    const result: Record<string, number> = {};
    allStores.forEach((store) => (result[store] = 0));
    todayTraffic.forEach((row) => {
      if (row?.store_name && result[row.store_name] !== undefined) {
        result[row.store_name] += row.entries;
      }
    });
    return result;
  }, [todayTraffic, allStores]);

  const lastYearByStore = useMemo(() => {
    const result: Record<string, number> = {};
    allStores.forEach((store) => (result[store] = 0));
    lastYearTraffic.forEach((row) => {
      if (row?.store_name && result[row.store_name] !== undefined) {
        result[row.store_name] += row.entries;
      }
    });
    return result;
  }, [lastYearTraffic, allStores]);

  const occupancyByStore = useMemo(() => {
    const result: Record<string, number> = {};
    allStores.forEach((store) => (result[store] = 0));
    todayTraffic.forEach((row) => {
      if (row?.store_name && result[row.store_name] !== undefined) {
        result[row.store_name] += row.entries;
        result[row.store_name] -= row.exits;
      }
    });
    return result;
  }, [todayTraffic, allStores]);

  return (
    <div className="py-2">
      {/* Page title */}
      <h1 className="font-serif-display text-2xl text-sh-blue tracking-wide mb-6">Dashboard</h1>

      {/* --- Traffic + Sales cards --- */}
      <section className="mb-10">
        <h2 className="font-sans text-xs uppercase tracking-[0.2em] text-sh-gray mb-4">
          Store Traffic
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {allStores.map((storeName) => (
            <StoreCard
              key={storeName}
              storeName={storeName}
              sales={salesByStore[getStoreLocationName(storeName)]}
              entriesToday={todayByStore[storeName] ?? 0}
              entriesLastYear={lastYearByStore[storeName] ?? 0}
              inStore={occupancyByStore[storeName] ?? 0}
              formatCurrency={formatCurrency}
            />
          ))}
        </div>
      </section>

      {/* --- Up-Boards --- */}
      <section className="mb-10">
        <h2 className="font-sans text-xs uppercase tracking-[0.2em] text-sh-gray mb-4">
          Designer Rotation
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {upBoardStores.map(({ store, label }) => (
            <UpBoard key={store} store={store} storeLabel={label} />
          ))}
        </div>
      </section>
    </div>
  );
}

function StoreCard({
  storeName,
  sales,
  entriesToday,
  entriesLastYear,
  inStore,
  formatCurrency,
}: {
  storeName: string;
  sales: StoreSales | undefined;
  entriesToday: number;
  entriesLastYear: number;
  inStore: number;
  formatCurrency: (value: number) => string;
}) {
  const netSales = sales?.netSales ?? 0;
  const itemCount = sales?.items ?? 0;
  const lyNet = sales?.lyNetSales ?? 0;
  const salesPct = lyNet > 0 ? ((netSales - lyNet) / lyNet) * 100 : null;

  return (
    <div className="bg-white border border-gray-200 p-5 text-center">
      <div className="font-serif-display text-sh-blue text-base tracking-wide mb-2">
        {getStoreDisplayName(storeName)}
      </div>
      <div className="text-3xl font-serif text-sh-blue font-light mb-1">{entriesToday}</div>
      <div className="text-xs font-sans uppercase tracking-wider text-sh-gray mb-3">
        Entries Today
      </div>
      <div className="flex justify-center gap-6 text-xs font-sans text-sh-gray mb-4">
        <div>
          <span className="text-sh-blue font-medium">{entriesLastYear}</span> LY
        </div>
        <div>
          <span className="text-sh-blue font-medium">{inStore}</span> In Store
        </div>
      </div>

      {/* Sales data */}
      <div className="border-t border-gray-100 pt-3">
        <div className="text-lg font-serif text-sh-blue font-light">{formatCurrency(netSales)}</div>
        <div className="text-xs font-sans uppercase tracking-wider text-sh-gray mt-0.5">
          Net Sales{itemCount > 0 ? ` (${itemCount} items)` : ""}
        </div>
        <div className="flex justify-center items-center gap-3 mt-2 text-xs font-sans">
          <span className="text-sh-gray">LY {formatCurrency(lyNet)}</span>
          <SalesTrend salesPct={salesPct} />
        </div>
      </div>
    </div>
  );
}

// Up/down trend chip, or an em-dash when there's no prior-year baseline.
// Extracted to avoid a nested ternary inside the card JSX.
function SalesTrend({ salesPct }: { salesPct: number | null }) {
  if (salesPct === null) {
    return <span className="text-sh-gray">--</span>;
  }
  const positive = salesPct >= 0;
  return (
    <span
      className={`flex items-center gap-0.5 font-medium ${positive ? "text-green-700" : "text-red-700"}`}
    >
      {positive ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
      {Math.abs(salesPct).toFixed(1)}%
    </span>
  );
}
