"use client";

// /app/src/app/(dashboard)/app/reports/opportunities/OpportunitiesView.tsx
//
// Marketing Opportunities hub. Tile counts via tRPC; per-tile drilldown fetched
// imperatively (dedup toggle + mark-sent). "Mark as sent" stays a REST POST to
// the log-send mutation route. MARKETING/ADMIN; the page gated server-side.

import { useState } from "react";
import axios from "axios";
import Link from "next/link";
import { toast } from "react-toastify";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ReportTable, ReportSection } from "@/components/report";
import type { ReportColumn } from "@/components/report";
import { LeadScoreBadge } from "@/components/customer/LeadScoreBadge";
import { WealthTierBadge } from "@/components/customer/WealthTierBadge";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";
import { getErrorMessage } from "@/lib/toastError";
import type { OpportunityRow, OpportunityTileSummary } from "@/lib/reports/opportunities";

const formatDate = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

const GROUP_CHIP: Record<string, { label: string; className: string }> = {
  FURNITURE: { label: "Furniture", className: "bg-sh-blue/10 text-sh-blue border-sh-blue/20" },
  HOME_ACC: { label: "Home Acc", className: "bg-amber-50 text-amber-700 border-amber-200" },
  APPAREL: { label: "Apparel", className: "bg-purple-50 text-purple-700 border-purple-200" },
  CHRISTMAS: { label: "Christmas", className: "bg-red-50 text-red-700 border-red-200" },
};

function renderGroupChip(group: string | null) {
  if (!group) return null;
  const cfg = GROUP_CHIP[group];
  if (!cfg) return null;
  return (
    <span
      className={`ml-2 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${cfg.className}`}
      title={`Primary group: ${cfg.label}`}
    >
      {cfg.label}
    </span>
  );
}

const customerName = (r: OpportunityRow) =>
  [r.firstName, r.lastName].filter(Boolean).join(" ") || "—";

interface DrillState {
  loading: boolean;
  rows: OpportunityRow[];
  showWealth: boolean;
  dedup: boolean;
  marking: boolean;
}

export function OpportunitiesView() {
  const money = useMoneyFormatter();
  const currency = (v: number) => money(v, { whole: true });
  const utils = api.useUtils();

  const tilesQuery = api.reports.opportunityTiles.useQuery();
  const data = tilesQuery.data;
  const loading = tilesQuery.isFetching && !data;

  const [expandedTile, setExpandedTile] = useState<string | null>(null);
  const [drill, setDrill] = useState<Record<string, DrillState>>({});

  function drillColumns(showWealth: boolean): ReportColumn<OpportunityRow>[] {
    const cols: ReportColumn<OpportunityRow>[] = [
      {
        key: "name",
        label: "Customer",
        sortable: true,
        render: (r) => (
          <span className={r.daysSinceLastSent !== null ? "opacity-60" : ""}>
            <Link href={`/app/sales/customers/${r.id}`} className="text-sh-blue hover:underline">
              {customerName(r)}
            </Link>
            {renderGroupChip(r.customerGroup)}
            {r.daysSinceLastSent !== null && (
              <span
                className="ml-2 rounded border border-amber-200 bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800"
                title="Logged as sent via this tile"
              >
                sent {r.daysSinceLastSent}d ago
              </span>
            )}
          </span>
        ),
        csvFormat: (r) => customerName(r),
        format: (r) => customerName(r),
      },
      { key: "email", label: "Email", sortable: true, format: (r) => r.email ?? "—" },
      { key: "phone", label: "Phone", format: (r) => r.phone ?? "—" },
      {
        key: "lifetimeSpend",
        label: "Lifetime",
        align: "right",
        sortable: true,
        format: (r) => currency(r.lifetimeSpend),
        csvFormat: (r) => r.lifetimeSpend,
      },
      {
        key: "lifetimeOrderCount",
        label: "Orders",
        align: "right",
        sortable: true,
        format: (r) => String(r.lifetimeOrderCount),
      },
      {
        key: "lastOrderDate",
        label: "Last Order",
        sortable: true,
        format: (r) => formatDate(r.lastOrderDate),
      },
      {
        key: "leadTier",
        label: "Lead",
        sortable: true,
        render: (r) => <LeadScoreBadge tier={r.leadTier} score={r.leadScore} />,
        format: (r) => r.leadTier ?? "—",
        csvFormat: (r) => r.leadTier ?? "",
      },
      {
        key: "primaryDesignerName",
        label: "Designer",
        sortable: true,
        format: (r) => r.primaryDesignerName ?? "—",
      },
    ];
    if (showWealth) {
      cols.splice(6, 0, {
        key: "wealthTier",
        label: "Wealth",
        sortable: true,
        render: (r) => (r.wealthTier ? <WealthTierBadge tier={r.wealthTier} /> : <span>—</span>),
        format: (r) => r.wealthTier ?? "—",
        csvFormat: (r) => r.wealthTier ?? "",
      });
    }
    return cols;
  }

  async function loadDrill(tileId: string, dedup: boolean) {
    setDrill((prev) => ({
      ...prev,
      [tileId]: {
        loading: true,
        rows: prev[tileId]?.rows ?? [],
        showWealth: prev[tileId]?.showWealth ?? false,
        dedup,
        marking: false,
      },
    }));
    try {
      const res = await utils.reports.opportunityDrill.fetch({ tileId, dedup });
      const showWealth = res.rows.some((r) => r.wealthTier !== undefined);
      setDrill((prev) => ({
        ...prev,
        [tileId]: { loading: false, rows: res.rows, showWealth, dedup, marking: false },
      }));
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to load list"));
      setDrill((prev) => ({
        ...prev,
        [tileId]: { loading: false, rows: [], showWealth: false, dedup, marking: false },
      }));
    }
  }

  async function handleExpand(tileId: string) {
    if (expandedTile === tileId) {
      setExpandedTile(null);
      return;
    }
    setExpandedTile(tileId);
    if (drill[tileId]?.rows.length) return;
    await loadDrill(tileId, true);
  }

  async function handleMarkSent(tileId: string) {
    const state = drill[tileId];
    if (!state || state.rows.length === 0) return;
    const count = state.rows.length;
    if (
      !confirm(
        `Log that you sent this segment to ${count} customer${count === 1 ? "" : "s"}? ` +
          `They will be hidden from this tile for the next 30 days.`,
      )
    ) {
      return;
    }
    setDrill((prev) => ({ ...prev, [tileId]: { ...prev[tileId], marking: true } }));
    try {
      await axios.post(`/api/reports/opportunities/${tileId}/log-send`, {
        customerIds: state.rows.map((r) => r.id),
      });
      toast.success(`Logged ${count} customer${count === 1 ? "" : "s"} as sent.`);
      await tilesQuery.refetch();
      await loadDrill(tileId, state.dedup);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to log campaign send"));
      setDrill((prev) => ({ ...prev, [tileId]: { ...prev[tileId], marking: false } }));
    }
  }

  return (
    <div className="space-y-6 font-serif">
      <nav className="text-sm text-sh-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">Opportunities</span>
      </nav>
      <div>
        <h1 className="text-2xl font-semibold text-sh-navy">Opportunities</h1>
        <p className="mt-1 text-sm text-sh-gray">
          These are the customer lists worth sending an email to this week. Click any tile to see
          the customers and download a spreadsheet.{" "}
          <Link
            href="/app/admin/setup/product-pairings"
            className="whitespace-nowrap text-sh-blue hover:underline"
          >
            Edit product pairings &rarr;
          </Link>
        </p>
      </div>

      {loading && <p className="py-8 text-sh-gray">Loading...</p>}

      {data && (
        <div className="space-y-3">
          {data.tiles.map((tile) => (
            <TileBlock
              key={tile.id}
              tile={tile}
              expanded={expandedTile === tile.id}
              drill={drill[tile.id]}
              currency={currency}
              columns={drillColumns}
              onToggle={() => handleExpand(tile.id)}
              onDedupChange={(next) => loadDrill(tile.id, next)}
              onMarkSent={() => handleMarkSent(tile.id)}
            />
          ))}
          {data.tiles.length === 0 && (
            <p className="py-16 text-center text-sh-gray">
              No opportunities at the moment. Check back after the next data refresh.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function lastSentLabel(iso: string | null): { text: string; tone: "gray" | "amber" } {
  if (!iso) return { text: "Never sent", tone: "gray" };
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return { text: "Sent today", tone: "amber" };
  if (days < 7) return { text: `Sent ${days}d ago`, tone: "amber" };
  return { text: `Last sent ${days}d ago`, tone: "gray" };
}

interface TileBlockProps {
  tile: OpportunityTileSummary;
  expanded: boolean;
  drill: DrillState | undefined;
  currency: (v: number) => string;
  columns: (showWealth: boolean) => ReportColumn<OpportunityRow>[];
  onToggle: () => void;
  onDedupChange: (next: boolean) => void;
  onMarkSent: () => void;
}

function TileBlock({
  tile,
  expanded,
  drill,
  currency,
  columns,
  onToggle,
  onDedupChange,
  onMarkSent,
}: Readonly<TileBlockProps>) {
  const sent = lastSentLabel(tile.lastSentAt);
  return (
    <div
      className={`rounded-xl border bg-white transition ${
        expanded ? "border-sh-blue/40 shadow-md" : "border-sh-gray/15 hover:border-sh-gray/30"
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex min-h-[80px] w-full items-start gap-4 px-5 py-4 text-left"
      >
        <div className="flex-shrink-0 pt-1">
          {expanded ? (
            <ChevronDown className="h-5 w-5 text-sh-gray" />
          ) : (
            <ChevronRight className="h-5 w-5 text-sh-gray" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-sh-navy">{tile.title}</h2>
          <p className="mt-0.5 text-sm text-sh-gray">{tile.description}</p>
        </div>
        <div className="flex-shrink-0 text-right">
          <p className="text-2xl font-semibold tabular-nums text-sh-navy">
            {tile.count.toLocaleString()}
          </p>
          <p className="mt-0.5 text-xs text-sh-gray">~{currency(tile.estPotential)} potential</p>
          <p
            className={`mt-0.5 text-xs ${sent.tone === "amber" ? "font-medium text-amber-700" : "text-sh-gray"}`}
          >
            {sent.text}
          </p>
        </div>
      </button>

      {expanded && (
        <div className="space-y-3 border-t border-sh-gray/10 p-5">
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-sh-gray">
              <input
                type="checkbox"
                checked={drill?.dedup ?? true}
                onChange={(e) => onDedupChange(e.target.checked)}
                className="h-5 w-5 accent-sh-blue"
                disabled={drill?.loading}
              />
              Hide customers emailed in last 30 days
            </label>
            {drill && !drill.loading && drill.rows.length > 0 && (
              <button
                type="button"
                onClick={onMarkSent}
                disabled={drill.marking}
                className="min-h-[44px] rounded-lg bg-sh-navy px-4 py-2 text-sm font-semibold text-white transition hover:bg-sh-blue disabled:opacity-50"
                title="Record that you sent this segment to the customers shown. Hides them for 30 days."
              >
                {drill.marking
                  ? "Logging..."
                  : `Mark ${drill.rows.length.toLocaleString()} as sent`}
              </button>
            )}
          </div>

          {drill?.loading && <p className="py-4 text-sm text-sh-gray">Loading list...</p>}
          {drill && !drill.loading && drill.rows.length === 0 && (
            <p className="py-4 text-sm text-sh-gray">
              {drill.dedup
                ? "No customers in this list right now (everyone here has been emailed in the last 30 days). Turn off the dedup filter to see the full list."
                : "No customers in this list right now."}
            </p>
          )}
          {drill && !drill.loading && drill.rows.length > 0 && (
            <ReportSection
              title={`${drill.rows.length.toLocaleString()} customers`}
              description="Sorted by lifetime spend, highest first. Use the Export CSV button to download for Mailchimp or spreadsheets."
            >
              <ReportTable<OpportunityRow>
                columns={columns(drill.showWealth)}
                rows={drill.rows}
                getRowKey={(r) => r.id}
                exportFilename={tile.id}
                emptyMessage="No customers"
                pageSize={50}
              />
            </ReportSection>
          )}
        </div>
      )}
    </div>
  );
}
