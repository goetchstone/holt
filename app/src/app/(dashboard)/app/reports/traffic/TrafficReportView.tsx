"use client";

// /app/src/app/(dashboard)/app/reports/traffic/TrafficReportView.tsx
//
// Axper traffic report. Date-range + store-filterable. Reads persisted
// TrafficSnapshot + live-pulls today via tRPC. KPIs + daily trend + per-store +
// hour-of-day + day-of-week + CSV export (export stays a REST download route).
// MANAGER+; the page gated server-side.

import { useMemo, useState } from "react";
import { Bar, Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
  Title,
} from "chart.js";
import { format, subDays } from "date-fns";
import { Button } from "@/components/ui/button";
import { KpiCard } from "@/components/report/KpiCard";
import { ChartCard } from "@/components/report/ChartCard";
import { getStoreColor } from "@/lib/storeColors";
import { api } from "@/lib/trpc/client";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
  Title,
);

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function TrafficReportView() {
  const today = useMemo(() => new Date(), []);
  const [dateFrom, setDateFrom] = useState<string>(fmtYmd(subDays(today, 29)));
  const [dateTo, setDateTo] = useState<string>(fmtYmd(today));
  const [storeFilter, setStoreFilter] = useState<Set<string> | null>(null);
  // Committed query inputs — initialized to the default range so the report runs
  // on mount; Apply copies the current inputs in.
  const [committed, setCommitted] = useState<{
    dateFrom: string;
    dateTo: string;
    stores: string[] | null;
  }>({
    dateFrom: fmtYmd(subDays(today, 29)),
    dateTo: fmtYmd(today),
    stores: null,
  });

  const query = api.reports.traffic.useQuery({
    dateFrom: committed.dateFrom,
    dateTo: committed.dateTo,
    stores: committed.stores,
  });
  const data = query.data;
  const loading = query.isFetching;

  function handleApply() {
    setCommitted({
      dateFrom,
      dateTo,
      stores: storeFilter && storeFilter.size > 0 ? Array.from(storeFilter) : null,
    });
  }

  function handleExport() {
    const params = new URLSearchParams({ dateFrom, dateTo });
    if (storeFilter && storeFilter.size > 0) {
      params.set("stores", Array.from(storeFilter).join(","));
    }
    window.open(`/api/reports/traffic/export?${params.toString()}`, "_blank");
  }

  const allStores = useMemo(() => (data ? data.byStore.map((s) => s.axperStoreName) : []), [data]);

  function toggleStore(name: string) {
    setStoreFilter((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const dailyTrendChart = useMemo(() => {
    if (!data) return null;
    const dates = data.byDay.map((d) => d.date);
    const storeNames = data.byStore.map((s) => s.axperStoreName);
    return {
      labels: dates,
      datasets: storeNames.map((name, i) => {
        const dataMap = new Map<string, number>();
        for (const row of data.byDayAndStore) {
          if (row.axperStoreName === name) dataMap.set(row.date, row.visitors);
        }
        return {
          label: data.byStore.find((s) => s.axperStoreName === name)?.displayName ?? name,
          data: dates.map((d) => dataMap.get(d) ?? 0),
          borderColor: getStoreColor(i, "solid"),
          backgroundColor: getStoreColor(i, "light"),
          tension: 0.2,
          pointRadius: dates.length > 60 ? 0 : 2,
        };
      }),
    };
  }, [data]);

  const perStoreBarChart = useMemo(() => {
    if (!data) return null;
    return {
      labels: data.byStore.map((s) => s.displayName),
      datasets: [
        {
          label: "Visitors",
          data: data.byStore.map((s) => s.visitors),
          backgroundColor: data.byStore.map((_, i) => getStoreColor(i, "solid")),
        },
      ],
    };
  }, [data]);

  const hourChart = useMemo(() => {
    if (!data) return null;
    const live = data.byHour.filter((h) => h.visitors > 0);
    if (live.length === 0) return null;
    return {
      labels: live.map((h) => `${h.hour}:00`),
      datasets: [
        { label: "Visitors", data: live.map((h) => h.visitors), backgroundColor: "#1e40af" },
      ],
    };
  }, [data]);

  const dowChart = useMemo(() => {
    if (!data) return null;
    return {
      labels: data.byDayOfWeek.map((d) => DOW_LABELS[d.dow]),
      datasets: [
        {
          label: "Visitors",
          data: data.byDayOfWeek.map((d) => d.visitors),
          backgroundColor: "#16a34a",
        },
      ],
    };
  }, [data]);

  const kpis = useMemo(() => {
    if (!data) return null;
    const totalVisitors = data.totals.visitors;
    const days = Math.max(1, data.totals.distinctDays);
    const avgPerDay = Math.round(totalVisitors / days);
    const busiest = data.byDay.reduce<(typeof data.byDay)[number] | null>(
      (best, row) => (best === null || row.visitors > best.visitors ? row : best),
      null,
    );
    const topStore = data.byStore[0] ?? null;
    const busiestHour = data.byHour
      .filter((h) => h.visitors > 0)
      .reduce<
        (typeof data.byHour)[number] | null
      >((best, row) => (best === null || row.visitors > best.visitors ? row : best), null);
    return { totalVisitors, avgPerDay, days, busiest, topStore, busiestHour };
  }, [data]);

  return (
    <div className="space-y-6 font-serif">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-sh-navy">Store Traffic</h1>
          <p className="mt-1 text-sm text-sh-gray">
            Per-store door-counter visitors from Axper. Historical days read from{" "}
            <code>TrafficSnapshot</code>; today is live-pulled from Axper on every load.
          </p>
          {data?.liveTodayPulled && (
            <p className="mt-1 text-xs text-sh-gold">Today included via live Axper pull.</p>
          )}
        </div>
        <Button onClick={handleExport} variant="outline" disabled={loading || !data}>
          Export CSV
        </Button>
      </div>

      <section className="rounded border border-sh-stripe bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="from" className="block text-xs font-medium text-sh-navy">
              From
            </label>
            <input
              id="from"
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="mt-1 rounded border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="to" className="block text-xs font-medium text-sh-navy">
              To
            </label>
            <input
              id="to"
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="mt-1 rounded border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div className="flex gap-2">
            <Button
              onClick={() => {
                const t = new Date();
                setDateFrom(fmtYmd(subDays(t, 6)));
                setDateTo(fmtYmd(t));
              }}
              variant="outline"
              disabled={loading}
            >
              Last 7d
            </Button>
            <Button
              onClick={() => {
                const t = new Date();
                setDateFrom(fmtYmd(subDays(t, 29)));
                setDateTo(fmtYmd(t));
              }}
              variant="outline"
              disabled={loading}
            >
              Last 30d
            </Button>
            <Button
              onClick={() => {
                const t = new Date();
                setDateFrom(fmtYmd(subDays(t, 89)));
                setDateTo(fmtYmd(t));
              }}
              variant="outline"
              disabled={loading}
            >
              Last 90d
            </Button>
            <Button onClick={handleApply} disabled={loading}>
              {loading ? "Loading…" : "Apply"}
            </Button>
          </div>
        </div>

        {allStores.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-sh-navy">Stores:</span>
            {allStores.map((name) => {
              const display =
                data?.byStore.find((s) => s.axperStoreName === name)?.displayName ?? name;
              const checked = storeFilter === null || storeFilter.has(name);
              return (
                <label key={name} className="flex cursor-pointer items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleStore(name)}
                    className="h-3.5 w-3.5"
                  />
                  {display}
                </label>
              );
            })}
            {storeFilter !== null && storeFilter.size > 0 && (
              <button
                type="button"
                onClick={() => setStoreFilter(null)}
                className="ml-2 text-xs text-sh-gold hover:underline"
              >
                Clear
              </button>
            )}
          </div>
        )}
      </section>

      {kpis && (
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <KpiCard
            label="Total Visitors"
            value={kpis.totalVisitors.toLocaleString()}
            sub={`${kpis.days} day${kpis.days === 1 ? "" : "s"} of data`}
          />
          <KpiCard
            label="Avg / Day"
            value={kpis.avgPerDay.toLocaleString()}
            sub="Across all selected stores"
          />
          <KpiCard
            label="Busiest Day"
            value={kpis.busiest ? kpis.busiest.visitors.toLocaleString() : "—"}
            sub={
              kpis.busiest
                ? format(new Date(`${kpis.busiest.date}T00:00:00`), "EEE MMM d, yyyy")
                : ""
            }
          />
          <KpiCard
            label="Busiest Hour"
            value={
              kpis.busiestHour ? `${kpis.busiestHour.hour}:00–${kpis.busiestHour.hour + 1}:00` : "—"
            }
            sub={
              kpis.busiestHour ? `${kpis.busiestHour.visitors.toLocaleString()} visitors total` : ""
            }
          />
        </section>
      )}

      <ChartCard
        title="Daily Visitors by Store"
        subtitle="One line per store. Hover any point for the exact count."
        loading={loading}
        empty={!loading && (!dailyTrendChart || dailyTrendChart.labels.length === 0)}
      >
        {dailyTrendChart && dailyTrendChart.labels.length > 0 && (
          <div className="h-72">
            <Line
              data={dailyTrendChart}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: "index", intersect: false },
                scales: { y: { beginAtZero: true } },
                plugins: { legend: { position: "top" } },
              }}
            />
          </div>
        )}
      </ChartCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard
          title="Total Visitors by Store"
          subtitle="Across the selected date range."
          loading={loading}
          empty={!loading && (!perStoreBarChart || perStoreBarChart.labels.length === 0)}
        >
          {perStoreBarChart && (
            <div className="h-64">
              <Bar
                data={perStoreBarChart}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: { legend: { display: false } },
                  scales: { y: { beginAtZero: true } },
                }}
              />
            </div>
          )}
        </ChartCard>

        <ChartCard
          title="Visitors by Day of Week"
          subtitle="Sun…Sat, summed across all selected days."
          loading={loading}
          empty={!loading && !dowChart}
        >
          {dowChart && (
            <div className="h-64">
              <Bar
                data={dowChart}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: { legend: { display: false } },
                  scales: { y: { beginAtZero: true } },
                }}
              />
            </div>
          )}
        </ChartCard>
      </div>

      <ChartCard
        title="Visitors by Hour of Day"
        subtitle="Local store time. Empty hours hidden so the bars are readable."
        loading={loading}
        empty={!loading && !hourChart}
      >
        {hourChart && (
          <div className="h-64">
            <Bar
              data={hourChart}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { y: { beginAtZero: true } },
              }}
            />
          </div>
        )}
      </ChartCard>

      {data && data.byStore.length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-semibold text-sh-navy">Per-store totals</h2>
          <div className="overflow-x-auto rounded border border-sh-stripe bg-white">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-sh-linen text-sh-black">
                <tr>
                  <th className="p-2 font-medium">Store (Axper)</th>
                  <th className="p-2 font-medium">Display name</th>
                  <th className="p-2 text-right font-medium">Visitors</th>
                  <th className="p-2 text-right font-medium">Exits</th>
                  <th className="p-2 text-right font-medium">Share</th>
                </tr>
              </thead>
              <tbody>
                {data.byStore.map((s) => {
                  const share =
                    data.totals.visitors > 0
                      ? `${((s.visitors / data.totals.visitors) * 100).toFixed(1)}%`
                      : "—";
                  return (
                    <tr key={s.axperStoreName} className="border-t border-sh-stripe">
                      <td className="p-2 font-mono text-xs">{s.axperStoreName}</td>
                      <td className="p-2">{s.displayName}</td>
                      <td className="p-2 text-right tabular-nums">{s.visitors.toLocaleString()}</td>
                      <td className="p-2 text-right tabular-nums">
                        {s.exits === null ? "—" : s.exits.toLocaleString()}
                      </td>
                      <td className="p-2 text-right tabular-nums">{share}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
