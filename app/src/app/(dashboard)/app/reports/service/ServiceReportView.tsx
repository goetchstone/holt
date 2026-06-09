"use client";

// /app/src/app/(dashboard)/app/reports/service/ServiceReportView.tsx
//
// Manager KPI view for the customer-service queue. Goal-days slider re-runs the
// math via tRPC (the query key includes goalDays, so react-query refetches on
// change). Charts via chart.js. MANAGER/ADMIN/SUPER_ADMIN; the page gated
// server-side.

import { useMemo, useState } from "react";
import Link from "next/link";
import { Bar, Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  Tooltip,
  Legend,
} from "chart.js";
import { KpiCard } from "@/components/report/KpiCard";
import { api } from "@/lib/trpc/client";
import type { ServiceReportResult, OldestOpenRow } from "@/lib/reports/serviceReport";

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  Tooltip,
  Legend,
);

type ServiceKpis = ServiceReportResult["kpis"];

function customerName(c: OldestOpenRow["customer"]): string {
  if (!c) return "—";
  const full = `${c.firstName || ""} ${c.lastName || ""}`.trim();
  return full || "—";
}

function formatDays(n: number | null): string {
  if (n == null) return "—";
  if (n === 0) return "0 days";
  if (n < 1) return "<1 day";
  return `${n.toFixed(1)} days`;
}

function buildOpenByStatusChart(k: ServiceKpis) {
  return {
    labels: k.openByStatus.map((s) => s.statusName),
    datasets: [
      { label: "Open cases", data: k.openByStatus.map((s) => s.count), backgroundColor: "#00263E" },
    ],
  };
}

function buildAgeBucketChart(k: ServiceKpis) {
  return {
    labels: k.ageBuckets.map((b) => b.label),
    datasets: [
      {
        label: "Open cases",
        data: k.ageBuckets.map((b) => b.count),
        backgroundColor: ["#16a34a", "#0891b2", "#d97706", "#dc2626"],
      },
    ],
  };
}

function buildTrendChart(k: ServiceKpis) {
  return {
    labels: k.resolutionTrend.map((p) => p.month),
    datasets: [
      {
        label: "Avg days to resolve",
        data: k.resolutionTrend.map((p) => p.avgDays),
        borderColor: "#A78A5A",
        backgroundColor: "#A78A5A33",
        tension: 0.3,
      },
      {
        label: "Goal",
        data: k.resolutionTrend.map(() => k.goalDays),
        borderColor: "#16a34a",
        borderDash: [5, 5],
        pointRadius: 0,
      },
    ],
  };
}

function KpiCardsRow({ k }: Readonly<{ k: ServiceKpis }>) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
      <KpiCard
        label="Open"
        value={k.openCount}
        sub={`${k.waitingExternallyCount} blocked externally`}
      />
      <KpiCard
        label="Avg resolution"
        value={formatDays(k.avgResolutionDays)}
        sub={`${k.closedInWindowCount} closed in 90d`}
      />
      <KpiCard
        label="Median resolution"
        value={formatDays(k.medianResolutionDays)}
        sub={`p90: ${formatDays(k.p90ResolutionDays)}`}
      />
      <KpiCard
        label={`Goal met (${k.goalDays}d)`}
        value={`${k.goalMetPercent}%`}
        sub={`${k.goalMetCount} of ${k.closedInWindowCount} cases`}
        positiveIsGood
        trend={k.goalMetPercent >= 80 ? "up" : "down"}
      />
      <KpiCard
        label="Oldest open"
        value={`${k.oldestOpenAgeDays}d`}
        positiveIsGood={false}
        trend={k.oldestOpenAgeDays > k.goalDays * 2 ? "up" : "neutral"}
      />
      <KpiCard
        label="Waiting externally"
        value={k.waitingExternallyCount}
        sub="vendor / customer"
      />
    </div>
  );
}

const BAR_OPTIONS = {
  responsive: true,
  plugins: { legend: { display: false } },
  scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
} as const;

const LINE_OPTIONS = {
  responsive: true,
  plugins: { legend: { position: "bottom" as const } },
  scales: { y: { beginAtZero: true, title: { display: true, text: "Days" } } },
} as const;

interface ChartCardProps {
  title: string;
  hasData: boolean;
  emptyText: string;
  children: React.ReactNode;
}

function ChartCard({ title, hasData, emptyText, children }: Readonly<ChartCardProps>) {
  return (
    <div className="rounded-lg border border-sh-stripe bg-white p-4">
      <h3 className="mb-3 text-sm font-semibold text-sh-navy">{title}</h3>
      {hasData ? children : <p className="text-sm text-sh-gray">{emptyText}</p>}
    </div>
  );
}

function OldestOpenTable({ rows }: Readonly<{ rows: OldestOpenRow[] }>) {
  return (
    <div className="overflow-hidden rounded-lg border border-sh-stripe bg-white">
      <div className="flex items-center justify-between border-b border-sh-stripe p-4">
        <h3 className="text-sm font-semibold text-sh-navy">10 oldest open cases</h3>
        <span className="text-xs text-sh-gray">click a row to open</span>
      </div>
      <table className="min-w-full text-left text-sm">
        <thead className="bg-sh-stripe text-sh-black">
          <tr>
            <th className="p-3 font-medium">Case #</th>
            <th className="p-3 font-medium">Customer</th>
            <th className="p-3 font-medium">Status</th>
            <th className="p-3 font-medium">Age</th>
            <th className="p-3 font-medium">Assigned</th>
            <th className="p-3 font-medium">Summary</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6} className="p-4 text-center text-sh-gray">
                No open cases.
              </td>
            </tr>
          ) : (
            rows.map((c) => (
              <tr key={c.id} className="border-t border-sh-stripe hover:bg-sh-linen">
                <td className="p-3 font-medium text-sh-blue">
                  <Link href={`/app/service/cases/${c.id}`} className="hover:underline">
                    {c.caseNumber}
                  </Link>
                </td>
                <td className="p-3">{customerName(c.customer)}</td>
                <td className="p-3">
                  <span
                    className="rounded px-2 py-0.5 text-xs text-white"
                    style={{ backgroundColor: c.status.color || "#6b7280" }}
                  >
                    {c.status.name}
                  </span>
                </td>
                <td className="whitespace-nowrap p-3 text-sh-gray">{c.ageDays} days</td>
                <td className="p-3">{c.assignedTo?.displayName ?? "—"}</td>
                <td className="max-w-md truncate p-3 text-sh-gray">{c.summary}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function ServiceReportView() {
  const [goalDays, setGoalDays] = useState(14);
  const query = api.reports.service.useQuery({ goalDays });
  const data = query.data;
  const loading = query.isFetching;

  const k = data?.kpis;
  const openByStatusChart = useMemo(() => (k ? buildOpenByStatusChart(k) : null), [k]);
  const ageBucketChart = useMemo(() => (k ? buildAgeBucketChart(k) : null), [k]);
  const trendChart = useMemo(() => (k ? buildTrendChart(k) : null), [k]);

  return (
    <div className="space-y-6 py-2 font-serif">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-3xl text-sh-navy">Service KPIs</h1>
          <p className="mt-1 text-sm text-sh-gray">
            Open queue health + resolution-time metrics. Closed-case window: last{" "}
            {data?.windowDays ?? 90} days.
          </p>
        </div>
        <Link href="/app/service" className="text-sm text-sh-gold hover:underline">
          ← Back to cases
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-sh-stripe bg-white p-4">
        <label htmlFor="goal-days" className="text-sm font-medium text-sh-navy">
          Resolution goal:
        </label>
        <input
          id="goal-days"
          type="range"
          min={3}
          max={60}
          step={1}
          value={goalDays}
          onChange={(e) => setGoalDays(Number.parseInt(e.target.value))}
          className="max-w-xs flex-1"
        />
        <span className="w-24 text-sm font-medium text-sh-navy">
          {goalDays} day{goalDays === 1 ? "" : "s"}
        </span>
        {k && (
          <span className="text-sm text-sh-gray">
            <strong className="text-sh-navy">{k.goalMetPercent}%</strong> of last{" "}
            {k.closedInWindowCount} closed cases hit this goal
          </span>
        )}
      </div>

      {loading || !k ? (
        <p className="text-sh-gray">Loading…</p>
      ) : (
        <>
          <KpiCardsRow k={k} />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ChartCard
              title="Open by status"
              hasData={!!openByStatusChart && k.openByStatus.length > 0}
              emptyText="No open cases."
            >
              {openByStatusChart && <Bar data={openByStatusChart} options={BAR_OPTIONS} />}
            </ChartCard>
            <ChartCard
              title="Open by age"
              hasData={!!ageBucketChart && k.openCount > 0}
              emptyText="No open cases."
            >
              {ageBucketChart && <Bar data={ageBucketChart} options={BAR_OPTIONS} />}
            </ChartCard>
          </div>

          <ChartCard
            title="Avg resolution time — last 6 months"
            hasData={!!trendChart && k.resolutionTrend.length > 0}
            emptyText="No closed cases in the last 6 months yet."
          >
            {trendChart && <Line data={trendChart} options={LINE_OPTIONS} />}
          </ChartCard>

          <OldestOpenTable rows={data?.oldestOpen ?? []} />
        </>
      )}
    </div>
  );
}
