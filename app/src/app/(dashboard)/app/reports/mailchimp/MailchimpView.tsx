"use client";

// /app/src/app/(dashboard)/app/reports/mailchimp/MailchimpView.tsx
//
// Mailchimp Campaign Impact -- every campaign ranked by attributed revenue
// (purchases made by customers who opened or clicked within 30 days). App Router
// port; reads the shared /api/mailchimp/* REST endpoints (also used by the admin
// mailchimp-sync surface), so those stay REST. Any signed-in user; gated server-side.

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import axios from "axios";
import Link from "next/link";
import { toast } from "react-toastify";
import { Cloud, RefreshCw, ShoppingCart, TrendingUp } from "lucide-react";
import { format, subDays } from "date-fns";
import { KpiCard, ReportSection } from "@/components/report";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";

interface CampaignRow {
  id: string;
  name: string | null;
  subject: string | null;
  sentAt: string | null;
  stats?: {
    emailsSent: number;
    opens: number;
    uniqueOpens: number;
    clicks: number;
    uniqueClicks: number;
  } | null;
  attribution: {
    purchasers: number;
    orderCount: number;
    revenue: number;
    revenuePerSend: number;
    openConversionPct: number;
    clickConversionPct: number;
  };
}

interface ListResponse {
  campaigns: CampaignRow[];
  total: number;
  attributionWindowDays: number;
}

type SortKey = "revenue" | "purchasers" | "revenuePerSend" | "sentAt" | "opens" | "clicks";

const PAGE_SIZE = 20;

const num = (v: number) => v.toLocaleString("en-US");

export function MailchimpView() {
  const router = useRouter();
  const money = useMoneyFormatter();
  const today = new Date();
  const defaultStart = format(subDays(today, 90), "yyyy-MM-dd");
  const defaultEnd = format(today, "yyyy-MM-dd");

  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState(defaultEnd);
  const [sortKey, setSortKey] = useState<SortKey>("sentAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [syncing, setSyncing] = useState(false);
  const [attributionWindow, setAttributionWindow] = useState(30);

  const fetchCampaigns = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        page: String(page),
        limit: String(PAGE_SIZE),
      });
      if (search) qs.set("search", search);
      if (startDate) qs.set("startDate", startDate);
      if (endDate) qs.set("endDate", endDate);
      const res = await axios.get<ListResponse>(`/api/mailchimp/campaigns/db?${qs.toString()}`);
      setCampaigns(res.data.campaigns);
      setTotal(res.data.total);
      setAttributionWindow(res.data.attributionWindowDays);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to load campaigns"));
    } finally {
      setLoading(false);
    }
  }, [page, search, startDate, endDate]);

  useEffect(() => {
    fetchCampaigns();
  }, [fetchCampaigns]);

  // Client-side sort on already-loaded page (20 rows, sort is instant).
  const sorted = [...campaigns].sort((a, b) => {
    const pull = (r: CampaignRow) => {
      switch (sortKey) {
        case "revenue":
          return r.attribution.revenue;
        case "purchasers":
          return r.attribution.purchasers;
        case "revenuePerSend":
          return r.attribution.revenuePerSend;
        case "sentAt":
          return r.sentAt ? new Date(r.sentAt).getTime() : 0;
        case "opens":
          return r.stats?.opens ?? 0;
        case "clicks":
          return r.stats?.clicks ?? 0;
      }
    };
    const av = pull(a);
    const bv = pull(b);
    return sortDir === "desc" ? bv - av : av - bv;
  });

  function toggleSort(k: SortKey) {
    if (sortKey === k) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(k);
      setSortDir("desc");
    }
  }

  const totals = campaigns.reduce(
    (acc, c) => {
      acc.sent += c.stats?.emailsSent ?? 0;
      acc.purchasers += c.attribution.purchasers;
      acc.revenue += c.attribution.revenue;
      return acc;
    },
    { sent: 0, purchasers: 0, revenue: 0 },
  );

  async function handleSync(path: string, label: string) {
    setSyncing(true);
    try {
      const res = await fetch(path, { method: "POST" });
      if (res.ok) {
        toast.success(`${label} synced`);
        fetchCampaigns();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(`${label} failed: ${data.error || "Unknown error"}`);
      }
    } catch {
      toast.error(`${label} failed`);
    } finally {
      setSyncing(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6 font-serif">
      <nav className="text-sm text-sh-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">Mailchimp Campaign Impact</span>
      </nav>

      <div>
        <h1 className="text-2xl font-semibold text-sh-navy">Mailchimp Campaign Impact</h1>
        <p className="text-sm text-sh-gray mt-1">
          Every campaign with the revenue it generated. Date range filters by{" "}
          <strong>when each campaign was sent</strong>; for each purchase within {attributionWindow}{" "}
          days of an open or click, credit goes to the{" "}
          <strong>most recent campaign the customer engaged with</strong> (last-touch, so campaigns
          don&apos;t double-count each other). Customers added to the list in the 60 days before a
          send are excluded — that filter keeps walk-ins who got subscribed on their first purchase
          from inflating the next campaign.
        </p>
      </div>

      {/* Filter bar */}
      <div className="bg-white border border-sh-gray/15 rounded-xl p-5 flex flex-wrap items-end gap-4">
        <div>
          <label
            htmlFor="mc-start"
            className="block text-xs font-semibold text-sh-gray uppercase tracking-wider mb-1"
          >
            Campaigns sent on or after
          </label>
          <input
            id="mc-start"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="border border-sh-gray/30 rounded-lg px-3 py-2 text-sm min-h-[44px]"
          />
        </div>
        <div>
          <label
            htmlFor="mc-end"
            className="block text-xs font-semibold text-sh-gray uppercase tracking-wider mb-1"
          >
            Campaigns sent on or before
          </label>
          <input
            id="mc-end"
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="border border-sh-gray/30 rounded-lg px-3 py-2 text-sm min-h-[44px]"
          />
        </div>
        <div className="flex-1 min-w-[180px]">
          <label
            htmlFor="mc-search"
            className="block text-xs font-semibold text-sh-gray uppercase tracking-wider mb-1"
          >
            Search
          </label>
          <input
            id="mc-search"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name or subject"
            className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm min-h-[44px]"
          />
        </div>
        <Button
          onClick={() => {
            setPage(1);
            fetchCampaigns();
          }}
          disabled={loading}
          className="min-h-[44px]"
        >
          {loading ? "Loading..." : "Run"}
        </Button>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => handleSync("/api/mailchimp/sync", "Campaigns")}
            disabled={syncing}
            className="min-h-[44px] flex items-center gap-2"
          >
            <Cloud className="w-4 h-4" /> Sync Campaigns
          </Button>
          <Button
            variant="outline"
            onClick={() => handleSync("/api/mailchimp/sync-metrics", "Metrics")}
            disabled={syncing}
            className="min-h-[44px] flex items-center gap-2"
          >
            <RefreshCw className="w-4 h-4" /> Sync Metrics
          </Button>
        </div>
      </div>

      {/* KPI strip (respects the page of loaded campaigns) */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Campaigns in view" value={num(campaigns.length)} />
        <KpiCard label="Emails sent" value={num(totals.sent)} />
        <KpiCard
          label="Purchasers"
          value={num(totals.purchasers)}
          sub={
            <span className="inline-flex items-center gap-1 text-xs text-sh-gray">
              <ShoppingCart className="w-3 h-3" />
              Unique customers who bought after engaging
            </span>
          }
        />
        <KpiCard
          label="Attributed $"
          value={money(totals.revenue, { whole: true })}
          sub={
            <span className="inline-flex items-center gap-1 text-xs text-sh-gray">
              <TrendingUp className="w-3 h-3" />
              Shared credit across campaigns
            </span>
          }
        />
      </div>

      {/* Campaign table */}
      <ReportSection
        title={`${total.toLocaleString()} campaigns`}
        description="Newest sends on top. Click any column header to re-sort, or click a campaign for the full breakdown."
      >
        <div className="bg-white rounded-xl border border-sh-gray/15 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-sh-gray/15 bg-sh-linen text-xs uppercase tracking-wide text-sh-gray">
                <th className="text-left px-4 py-2 font-semibold">Campaign</th>
                <SortHeader
                  label="Sent"
                  active={sortKey === "sentAt"}
                  dir={sortDir}
                  onClick={() => toggleSort("sentAt")}
                />
                <SortHeader
                  label="Purchasers"
                  active={sortKey === "purchasers"}
                  dir={sortDir}
                  onClick={() => toggleSort("purchasers")}
                  align="right"
                />
                <SortHeader
                  label="Attributed $"
                  active={sortKey === "revenue"}
                  dir={sortDir}
                  onClick={() => toggleSort("revenue")}
                  align="right"
                />
                <SortHeader
                  label="$ / Send"
                  active={sortKey === "revenuePerSend"}
                  dir={sortDir}
                  onClick={() => toggleSort("revenuePerSend")}
                  align="right"
                />
                <th className="text-right px-4 py-2 font-semibold">Sent</th>
                <SortHeader
                  label="Opens"
                  active={sortKey === "opens"}
                  dir={sortDir}
                  onClick={() => toggleSort("opens")}
                  align="right"
                />
                <SortHeader
                  label="Clicks"
                  active={sortKey === "clicks"}
                  dir={sortDir}
                  onClick={() => toggleSort("clicks")}
                  align="right"
                />
              </tr>
            </thead>
            <tbody>
              {sorted.map((c, i) => (
                <tr
                  key={c.id}
                  className={`border-b border-sh-gray/10 cursor-pointer hover:bg-sh-linen transition ${i % 2 === 1 ? "bg-sh-stripe" : ""}`}
                  onClick={() => router.push(`/app/reports/mailchimp/campaigns/${c.id}`)}
                >
                  <td className="px-4 py-2">
                    <div className="text-sh-black font-medium">{c.name || "(no name)"}</div>
                    {c.subject && <div className="text-xs text-sh-gray">{c.subject}</div>}
                  </td>
                  <td className="px-4 py-2 text-sh-gray">
                    {c.sentAt ? format(new Date(c.sentAt), "MMM d, yyyy") : "Draft"}
                  </td>
                  <td className="px-4 py-2 text-right font-semibold text-sh-navy tabular-nums">
                    {num(c.attribution.purchasers)}
                  </td>
                  <td className="px-4 py-2 text-right font-semibold text-sh-navy tabular-nums">
                    {money(c.attribution.revenue, { whole: true })}
                  </td>
                  <td className="px-4 py-2 text-right text-sh-black tabular-nums">
                    {c.attribution.revenuePerSend > 0 ? money(c.attribution.revenuePerSend) : "—"}
                  </td>
                  <td className="px-4 py-2 text-right text-sh-gray tabular-nums">
                    {c.stats?.emailsSent ? num(c.stats.emailsSent) : "—"}
                  </td>
                  <td className="px-4 py-2 text-right text-sh-gray tabular-nums">
                    {c.stats?.opens ? num(c.stats.opens) : "—"}
                  </td>
                  <td className="px-4 py-2 text-right text-sh-gray tabular-nums">
                    {c.stats?.clicks ? num(c.stats.clicks) : "—"}
                  </td>
                </tr>
              ))}
              {!loading && sorted.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-sh-gray">
                    No campaigns match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between pt-3">
            <span className="text-xs text-sh-gray">
              Page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
              >
                Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </ReportSection>

      <p className="text-xs text-sh-gray">
        Looking for raw open/click events?{" "}
        <Link href="/app/reports/mailchimp/activity" className="text-sh-blue hover:underline">
          Activity log →
        </Link>
      </p>
    </div>
  );
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
  align = "left",
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  align?: "left" | "right";
}) {
  return (
    <th
      className={`${align === "right" ? "text-right" : "text-left"} px-4 py-2 font-semibold cursor-pointer select-none`}
      onClick={onClick}
    >
      <span className={active ? "text-sh-blue" : ""}>{label}</span>
      {active && <span className="ml-1 text-sh-blue">{dir === "desc" ? "↓" : "↑"}</span>}
    </th>
  );
}
