// /app/src/components/dashboard/TodayTrafficChart.tsx

import { useMemo } from "react";
import { format } from "date-fns";
import { Bar } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip,
  Legend,
} from "chart.js";
import { getStoreColor, getStoreDisplayName } from "@/lib/storeColors";

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

type HourlyDataRow = {
  hour: string;
  [store: string]: string | number;
};

export default function TodayTrafficChart({ todayTraffic }: { todayTraffic: any[] }) {
  const allStores = useMemo(() => {
    if (!Array.isArray(todayTraffic)) return [];
    const names = new Set<string>();
    todayTraffic.forEach((row) => {
      if (row?.store_name) names.add(row.store_name);
    });
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [todayTraffic]);

  const hourlyData: HourlyDataRow[] = useMemo(() => {
    if (!todayTraffic || todayTraffic.length === 0) return [];

    const result: Record<string, Record<string, number>> = {};

    todayTraffic.forEach((row) => {
      if (!row?.local_time || !row?.store_name || typeof row.entries !== "number") return;
      const hour = format(new Date(row.local_time), "HH:mm");
      if (!result[hour]) {
        result[hour] = {};
        allStores.forEach((store) => {
          result[hour][store] = 0;
        });
      }
      result[hour][row.store_name] += row.entries;
    });

    return Object.keys(result)
      .sort((a, b) => a.localeCompare(b))
      .map((hour) => ({ hour, ...result[hour] }));
  }, [todayTraffic, allStores]);

  if (hourlyData.length === 0) {
    return (
      <div className="bg-white p-6 rounded-2xl shadow text-center text-gray-500 font-serif">
        No traffic data available for today.
      </div>
    );
  }

  return (
    <div className="bg-white p-6 rounded-2xl shadow">
      <h2 className="text-xl font-serif text-sh-blue mb-4">
        Today&apos;s Hourly Traffic (by Store)
      </h2>
      <Bar
        data={{
          labels: hourlyData.map((d) => d.hour),
          datasets: allStores.map((store, i) => ({
            label: getStoreDisplayName(store),
            data: hourlyData.map((d) => (d[store] as number) || 0),
            backgroundColor: getStoreColor(i),
          })),
        }}
        options={{
          responsive: true,
          plugins: { legend: { position: "top" } },
          scales: {
            x: { title: { display: true, text: "Time" } },
            y: { title: { display: true, text: "Entries" }, beginAtZero: true },
          },
        }}
      />
    </div>
  );
}
