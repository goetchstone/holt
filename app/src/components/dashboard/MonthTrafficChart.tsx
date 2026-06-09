// /app/src/components/dashboard/MonthTrafficChart.tsx

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

type DailyDataRow = {
  date: string;
  [store: string]: string | number;
};

type Props = {
  monthTraffic: any[];
};

export default function MonthTrafficChart({ monthTraffic }: Props) {
  const allStores = useMemo(() => {
    if (!Array.isArray(monthTraffic)) return [];
    const names = new Set<string>();
    monthTraffic.forEach((row) => {
      if (row?.store_name) names.add(row.store_name);
    });
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [monthTraffic]);

  const dailyData: DailyDataRow[] = useMemo(() => {
    if (!Array.isArray(monthTraffic) || monthTraffic.length === 0) return [];

    const result: Record<string, Record<string, number>> = {};

    const validRows = monthTraffic.filter(
      (row) => row && row.local_time && row.store_name && typeof row.entries === "number",
    );

    validRows.forEach((row) => {
      const date = format(new Date(row.local_time), "yyyy-MM-dd");
      if (!result[date]) {
        result[date] = {};
        allStores.forEach((store) => {
          result[date][store] = 0;
        });
      }
      result[date][row.store_name] += row.entries;
    });

    return Object.keys(result)
      .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
      .map((date) => ({ date, ...result[date] }));
  }, [monthTraffic, allStores]);

  if (dailyData.length === 0) {
    return (
      <div className="bg-white p-6 rounded-2xl shadow text-center text-gray-500 font-serif">
        No traffic data available for this month.
      </div>
    );
  }

  return (
    <div className="bg-white p-6 rounded-2xl shadow">
      <h2 className="text-xl font-serif text-sh-blue mb-4">
        Month / Quarter Traffic Trend (by Store)
      </h2>
      <Bar
        data={{
          labels: dailyData.map((d) => d.date),
          datasets: allStores.map((store, i) => ({
            label: getStoreDisplayName(store),
            data: dailyData.map((d) => (d[store] as number) || 0),
            backgroundColor: getStoreColor(i),
          })),
        }}
        options={{
          responsive: true,
          plugins: { legend: { position: "top" } },
          scales: {
            x: { title: { display: true, text: "Date" } },
            y: { title: { display: true, text: "Entries" }, beginAtZero: true },
          },
        }}
      />
    </div>
  );
}
