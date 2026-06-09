"use client";

// /app/src/app/(dashboard)/app/reports/mailchimp/campaigns/[id]/CampaignDetailView.tsx
//
// Mailchimp campaign detail -- stats, attributed purchases, and the activity
// log for a single campaign. App Router port; reads the shared /api/mailchimp/*
// REST endpoints (also used by the admin mailchimp-sync surface), so those stay
// REST. Any signed-in user; gated server-side. The campaign id arrives as a prop
// from the server page.

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import axios from "axios";
import { toast } from "react-toastify";
import { format } from "date-fns";
import { ShoppingCart, TrendingUp, Users, Percent } from "lucide-react";
import PaginatedTable, { type Column } from "@/components/table/PaginatedTable";
import { KpiCard, ReportSection } from "@/components/report";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

interface CampaignStats {
  emailsSent: number;
  opens: number;
  uniqueOpens: number;
  clicks: number;
  uniqueClicks: number;
  bounces: number;
  unsubscribed: number;
}

interface AttributionDept {
  departmentName: string;
  revenue: number;
  orderCount: number;
}

interface AttributionTopPurchaser {
  customerId: number;
  name: string | null;
  email: string | null;
  revenue: number;
  orderCount: number;
}

interface CampaignAttribution {
  windowDays: number;
  uniqueOpeners: number;
  uniqueClickers: number;
  uniqueEngaged: number;
  openersWhoPurchased: number;
  clickersWhoPurchased: number;
  purchasers: number;
  orderCount: number;
  revenue: number;
  avgOrderValue: number;
  openConversionPct: number;
  clickConversionPct: number;
  revenueByDepartment: AttributionDept[];
  topPurchasers: AttributionTopPurchaser[];
  unlinkedEngagements: number;
}

interface CampaignDetail {
  id: string;
  name: string | null;
  subject: string | null;
  sentAt: string | null;
  stats: CampaignStats | null;
  _count: { activities: number };
  attribution: CampaignAttribution | null;
}

interface ActivityRow {
  email: string;
  action: string;
  timestamp: string;
  customer?: { firstName: string | null; lastName: string | null } | null;
}

const fmtPct = (n: number, total: number) =>
  total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "--";
const num = (v: number) => v.toLocaleString("en-US");

export function CampaignDetailView({ id }: { id: string }) {
  const router = useRouter();
  const money = useMoneyFormatter();

  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [activities, setActivities] = useState<ActivityRow[]>([]);
  const [totalActivities, setTotalActivities] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState<string | null>(null);
  const rowsPerPage = 20;

  const fetchCampaign = useCallback(async (campaignId: string) => {
    try {
      const res = await axios.get(`/api/mailchimp/campaigns/${campaignId}`);
      setCampaign(res.data);
    } catch {
      toast.error("Failed to load campaign");
    }
  }, []);

  const fetchActivities = useCallback(
    async (campaignId: string, pg: number, action: string | null) => {
      try {
        const params: Record<string, string | number> = { page: pg, limit: rowsPerPage };
        if (action) params.action = action;
        const res = await axios.get(`/api/mailchimp/activities/${campaignId}`, { params });
        setActivities(res.data.activities || []);
        setTotalActivities(res.data.total || 0);
      } catch {
        setActivities([]);
      }
    },
    [rowsPerPage],
  );

  useEffect(() => {
    fetchCampaign(id);
    fetchActivities(id, page, actionFilter);
  }, [id, page, actionFilter, fetchCampaign, fetchActivities]);

  async function handleSync() {
    setSyncing(true);
    try {
      await axios.post("/api/mailchimp/sync-activity", { campaignId: id });
      toast.success("Activity synced");
      fetchCampaign(id);
      fetchActivities(id, 1, actionFilter);
      setPage(1);
    } catch {
      toast.error("Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  function toggleFilter(action: string) {
    setActionFilter((prev) => (prev === action ? null : action));
    setPage(1);
  }

  const stats = campaign?.stats;
  const sent = stats?.emailsSent ?? 0;

  const columns: Column[] = [
    {
      key: "email",
      label: "Email",
      accessor: "email",
      width: "35%",
      render: (row: ActivityRow) => (
        <span>
          {row.email}
          {row.customer && (
            <span className="text-sh-gray ml-2 text-xs">
              ({[row.customer.firstName, row.customer.lastName].filter(Boolean).join(" ")})
            </span>
          )}
        </span>
      ),
    },
    {
      key: "action",
      label: "Action",
      accessor: "action",
      width: "15%",
      render: (row: ActivityRow) => (
        <span
          className={`text-xs px-2 py-0.5 rounded ${
            row.action === "open"
              ? "bg-blue-50 text-blue-700"
              : row.action === "click"
                ? "bg-green-50 text-green-700"
                : row.action === "bounce"
                  ? "bg-red-50 text-red-700"
                  : "bg-gray-50 text-gray-700"
          }`}
        >
          {row.action}
        </span>
      ),
    },
    {
      key: "timestamp",
      label: "Timestamp",
      accessor: "timestamp",
      width: "25%",
      render: (row: ActivityRow) => format(new Date(row.timestamp), "PPp"),
    },
  ];

  return (
    <div className="py-2 font-serif space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-semibold text-sh-blue">
            {campaign?.name || "Campaign Details"}
          </h1>
          {campaign?.subject && <p className="text-sm text-sh-gray mt-1">{campaign.subject}</p>}
          {campaign?.sentAt && (
            <p className="text-xs text-sh-gray mt-0.5">
              Sent {format(new Date(campaign.sentAt), "PPP")}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => router.push("/app/reports/mailchimp")}>
            Back
          </Button>
          <Button onClick={handleSync} disabled={syncing}>
            {syncing ? "Syncing..." : "Sync Activity"}
          </Button>
        </div>
      </div>

      {/* Stats cards */}
      {stats && (
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
          <StatCard
            label="Sent"
            value={sent.toLocaleString()}
            active={actionFilter === null}
            onClick={() => setActionFilter(null)}
          />
          <StatCard
            label="Opens"
            value={stats.opens.toLocaleString()}
            sub={fmtPct(stats.uniqueOpens, sent)}
            active={actionFilter === "open"}
            onClick={() => toggleFilter("open")}
          />
          <StatCard
            label="Clicks"
            value={stats.clicks.toLocaleString()}
            sub={fmtPct(stats.uniqueClicks, sent)}
            active={actionFilter === "click"}
            onClick={() => toggleFilter("click")}
          />
          <StatCard
            label="Bounces"
            value={stats.bounces.toLocaleString()}
            sub={fmtPct(stats.bounces, sent)}
            active={actionFilter === "bounce"}
            onClick={() => toggleFilter("bounce")}
          />
          <StatCard
            label="Unsubs"
            value={stats.unsubscribed.toLocaleString()}
            sub={fmtPct(stats.unsubscribed, sent)}
          />
          <StatCard label="Activities" value={totalActivities.toLocaleString()} />
        </div>
      )}

      {/* Attribution section */}
      {campaign?.attribution && (
        <AttributionSection attribution={campaign.attribution} money={money} />
      )}

      {/* Activity table */}
      <div>
        <div className="flex items-center gap-3 mb-3">
          <h2 className="text-lg font-semibold text-sh-black">Activity Log</h2>
          {actionFilter && (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-sh-blue/10 text-sh-blue">
              Filtered: {actionFilter}
              <button
                onClick={() => {
                  setActionFilter(null);
                  setPage(1);
                }}
                className="ml-1 hover:text-sh-navy font-semibold"
                aria-label="Clear filter"
              >
                x
              </button>
            </span>
          )}
        </div>
        <PaginatedTable
          data={activities}
          columns={columns}
          totalCount={totalActivities}
          onPageChange={setPage}
          currentPage={page}
          rowsPerPage={rowsPerPage}
        />
      </div>
    </div>
  );
}

function AttributionSection({
  attribution,
  money,
}: {
  attribution: CampaignAttribution;
  money: (value: number | null | undefined, opts?: { whole?: boolean }) => string;
}) {
  const {
    windowDays,
    purchasers,
    orderCount,
    revenue,
    avgOrderValue,
    openConversionPct,
    clickConversionPct,
    uniqueEngaged,
    revenueByDepartment,
    topPurchasers,
    unlinkedEngagements,
  } = attribution;

  return (
    <ReportSection
      title="Attributed Purchases"
      description={`Customers who opened or clicked and bought something within ${windowDays} days. Credit is shared across campaigns when a customer engaged with more than one.`}
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label="Purchasers"
          value={num(purchasers)}
          sub={
            <span className="inline-flex items-center gap-1 text-xs text-sh-gray">
              <Users className="w-3 h-3" />
              of {num(uniqueEngaged)} engaged
            </span>
          }
        />
        <KpiCard
          label="Orders"
          value={num(orderCount)}
          sub={
            <span className="inline-flex items-center gap-1 text-xs text-sh-gray">
              <ShoppingCart className="w-3 h-3" />
              avg {money(avgOrderValue, { whole: true })}
            </span>
          }
        />
        <KpiCard
          label="Attributed $"
          value={money(revenue, { whole: true })}
          sub={
            <span className="inline-flex items-center gap-1 text-xs text-sh-gray">
              <TrendingUp className="w-3 h-3" />
              {windowDays}-day window
            </span>
          }
        />
        <KpiCard
          label="Conversion"
          value={`${openConversionPct.toFixed(1)}%`}
          sub={
            <span className="inline-flex items-center gap-1 text-xs text-sh-gray">
              <Percent className="w-3 h-3" />
              clickers: {clickConversionPct.toFixed(1)}%
            </span>
          }
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <div className="bg-white border border-sh-gray/15 rounded-xl overflow-hidden">
          <div className="px-4 py-2 border-b border-sh-gray/15 bg-sh-linen text-xs uppercase tracking-wide text-sh-gray font-semibold">
            Revenue by department
          </div>
          {revenueByDepartment.length === 0 ? (
            <div className="px-4 py-6 text-sm text-sh-gray text-center">
              No attributed purchases.
            </div>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {revenueByDepartment.map((d) => (
                  <tr key={d.departmentName} className="border-b border-sh-gray/10 last:border-0">
                    <td className="px-4 py-2 text-sh-black">{d.departmentName}</td>
                    <td className="px-4 py-2 text-right text-sh-gray tabular-nums">
                      {num(d.orderCount)} orders
                    </td>
                    <td className="px-4 py-2 text-right font-semibold text-sh-navy tabular-nums">
                      {money(d.revenue, { whole: true })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="bg-white border border-sh-gray/15 rounded-xl overflow-hidden">
          <div className="px-4 py-2 border-b border-sh-gray/15 bg-sh-linen text-xs uppercase tracking-wide text-sh-gray font-semibold">
            Top purchasers
          </div>
          {topPurchasers.length === 0 ? (
            <div className="px-4 py-6 text-sm text-sh-gray text-center">
              No attributed purchases.
            </div>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {topPurchasers.map((p) => (
                  <tr key={p.customerId} className="border-b border-sh-gray/10 last:border-0">
                    <td className="px-4 py-2">
                      <Link
                        href={`/app/sales/customers/${p.customerId}`}
                        className="text-sh-blue hover:underline"
                      >
                        {p.name || p.email || `Customer #${p.customerId}`}
                      </Link>
                      {p.name && p.email && <div className="text-xs text-sh-gray">{p.email}</div>}
                    </td>
                    <td className="px-4 py-2 text-right text-sh-gray tabular-nums">
                      {num(p.orderCount)} orders
                    </td>
                    <td className="px-4 py-2 text-right font-semibold text-sh-navy tabular-nums">
                      {money(p.revenue, { whole: true })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {unlinkedEngagements > 0 && (
        <p className="text-xs text-sh-gray mt-3">
          {num(unlinkedEngagements)} engagement{unlinkedEngagements === 1 ? "" : "s"} could not be
          matched to a customer record and are excluded from attribution.
        </p>
      )}
    </ReportSection>
  );
}

function StatCard({
  label,
  value,
  sub,
  active,
  onClick,
}: {
  label: string;
  value: string;
  sub?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  const interactive = !!onClick;
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={interactive ? (e) => e.key === "Enter" && onClick?.() : undefined}
      className={`rounded-lg p-3 text-center shadow-sm border transition-colors ${
        active ? "border-sh-blue bg-sh-blue/5 ring-1 ring-sh-blue" : "border-sh-gray/20 bg-white"
      } ${interactive ? "cursor-pointer hover:border-sh-blue/50" : ""}`}
    >
      <p className="text-xs text-sh-gray uppercase tracking-wide">{label}</p>
      <p className="text-lg font-semibold text-sh-black">{value}</p>
      {sub && <p className="text-xs text-sh-gray">{sub}</p>}
    </div>
  );
}
