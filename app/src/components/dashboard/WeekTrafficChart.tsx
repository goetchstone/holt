// /app/src/components/dashboard/WeekTrafficChart.tsx

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
  day: string;
  [store: string]: string | number;
};

type Props = {
  weekTraffic: any[];
  lastYearWeekTraffic: any[];
};

function aggregateByDay(traffic: any[], allStores: string[]): DailyDataRow[] {
  const dayOrder = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const result: Record<string, Record<string, number>> = {};

  const validRows = traffic.filter(
    (row) => row && row.local_time && row.store_name && typeof row.entries === "number",
  );

  validRows.forEach((row) => {
    const day = format(new Date(row.local_time), "EEE");
    if (!result[day]) {
      result[day] = {};
      allStores.forEach((store) => {
        result[day][store] = 0;
      });
    }
    result[day][row.store_name] += row.entries;
  });

  return Object.keys(result)
    .sort((a, b) => dayOrder.indexOf(a) - dayOrder.indexOf(b))
    .map((day) => ({ day, ...result[day] }));
}

export default function WeekTrafficChart({ weekTraffic, lastYearWeekTraffic }: Props) {
  // Derive store names from both this year and last year data
  const allStores = useMemo(() => {
    const names = new Set<string>();
    const both = [...(weekTraffic || []), ...(lastYearWeekTraffic || [])];
    both.forEach((row) => {
      if (row?.store_name) names.add(row.store_name);
    });
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [weekTraffic, lastYearWeekTraffic]);

  const dailyData = useMemo(
    () => aggregateByDay(weekTraffic || [], allStores),
    [weekTraffic, allStores],
  );

  const lastYearDailyData = useMemo(
    () => aggregateByDay(lastYearWeekTraffic || [], allStores),
    [lastYearWeekTraffic, allStores],
  );

  if (dailyData.length === 0) {
    return (
      <div className="bg-white p-6 rounded-2xl shadow text-center text-gray-500 font-serif">
        No traffic data available for this week.
      </div>
    );
  }

  const labels = dailyData.map((d) => d.day);

  // Build datasets: this year (solid) + last year (light) for each store
  const datasets = allStores.flatMap((store, i) => {
    const displayName = getStoreDisplayName(store);
    return [
      {
        label: `${displayName} - This Year`,
        data: dailyData.map((d) => (d[store] as number) || 0),
        backgroundColor: getStoreColor(i, "solid"),
      },
      {
        label: `${displayName} - Last Year`,
        data: lastYearDailyData.map((d) => (d[store] as number) || 0),
        backgroundColor: getStoreColor(i, "light"),
      },
    ];
  });

  return (
    <div className="bg-white p-6 rounded-2xl shadow">
      <h2 className="text-xl font-serif text-sh-blue mb-4">This Week vs Last Year (by Store)</h2>
      <Bar
        data={{ labels, datasets }}
        options={{
          responsive: true,
          plugins: { legend: { position: "top" } },
          scales: {
            x: { title: { display: true, text: "Day" } },
            y: { title: { display: true, text: "Entries" }, beginAtZero: true },
          },
        }}
      />
    </div>
  );
}
