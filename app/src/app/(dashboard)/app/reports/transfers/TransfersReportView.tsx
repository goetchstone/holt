"use client";

// /app/src/app/(dashboard)/app/reports/transfers/TransfersReportView.tsx
//
// Transfers: what moved between stores in a period, by route and one by one, and
// what is still on its way (lib/reports/transfersReport.ts). "On the way now"
// ignores the period, so an old transfer nobody received can't hide behind it.
// Cost only for a viewer holding "View cost".

import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { CostHiddenNote } from "@/components/ui/CostHiddenNote";
import { api } from "@/lib/trpc/client";
import { addDays } from "@/lib/reports/businessDay";
import {
  TRANSFER_STATUS_LABELS,
  TRANSFER_VIEWS,
  type TransferView,
} from "@/lib/reports/transfersReportShared";

const qtyFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
const VIEWS = Object.keys(TRANSFER_VIEWS) as TransferView[];
const transfersText = (n: number) => `${qtyFmt.format(n)} ${n === 1 ? "transfer" : "transfers"}`;

export function TransfersReportView({
  stores,
  today,
}: {
  readonly stores: readonly { id: number; name: string }[];
  /** The store's day: the period starts at the 30 days up to it. */
  readonly today: string;
}) {
  const money = useMoneyFormatter();
  const fmt = (v: number) => money(v, { whole: true });
  const [startDate, setStartDate] = useState(addDays(today, -30));
  const [endDate, setEndDate] = useState(today);
  const [view, setView] = useState<TransferView>("moved");
  const [storeId, setStoreId] = useState("");

  const query = api.reports.transfersReport.useQuery(
    { startDate, endDate, view, storeLocationId: storeId ? Number(storeId) : null },
    { enabled: startDate !== "" && endDate !== "", retry: false },
  );
  const data = query.data;
  const costTotals = data && "costValue" in data.totals ? data.totals : null;
  const ignoresPeriod = view === "in_transit";

  return (
    <div className="space-y-6 font-serif">
      <nav className="text-sm text-brand-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-brand-black">Transfers</span>
      </nav>
      <h1 className="text-2xl font-semibold text-brand-navy">Transfers</h1>
      <p className="text-sm text-brand-gray">
        What moved between stores, by the day it was sent. &quot;Moved&quot; is what actually left:
        a transfer not sent yet moved nothing, and a cancelled one came back, so each has its own
        view.
      </p>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <span className="mb-1 block text-xs font-medium text-brand-gray">Show</span>
          <div className="inline-flex flex-wrap overflow-hidden rounded border border-gray-300">
            {VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`min-h-[44px] px-4 text-sm transition ${
                  view === v
                    ? "bg-brand-navy text-white"
                    : "bg-white text-brand-black hover:bg-brand-linen"
                }`}
              >
                {TRANSFER_VIEWS[v].label}
              </button>
            ))}
          </div>
        </div>
        {!ignoresPeriod && (
          <>
            <div>
              <label
                htmlFor="transfers-from"
                className="mb-1 block text-xs font-medium text-brand-gray"
              >
                Sent from
              </label>
              <input
                id="transfers-from"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
              />
            </div>
            <div>
              <label
                htmlFor="transfers-to"
                className="mb-1 block text-xs font-medium text-brand-gray"
              >
                To
              </label>
              <input
                id="transfers-to"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
              />
            </div>
          </>
        )}
        <div>
          <label
            htmlFor="transfers-store"
            className="mb-1 block text-xs font-medium text-brand-gray"
          >
            To or from
          </label>
          <select
            id="transfers-store"
            value={storeId}
            onChange={(e) => setStoreId(e.target.value)}
            className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
          >
            <option value="">All stores</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {ignoresPeriod && (
        <p className="text-xs text-brand-gray">Everything on its way now, whenever it was sent.</p>
      )}
      {query.isFetching && !data && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-brand-gold" />
        </div>
      )}
      {query.error && <p className="text-sm text-red-700">{query.error.message}</p>}

      {data && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-lg border border-brand-gray/20 bg-white p-4 shadow-sm">
              <div className="text-xs uppercase tracking-wide text-brand-gray">
                {TRANSFER_VIEWS[data.view].label}
              </div>
              <div className="mt-1 text-2xl font-semibold text-brand-navy">
                {qtyFmt.format(data.totals.units)} units
              </div>
              <div className="text-xs text-brand-gray">
                {transfersText(data.totals.transfers)}
                {costTotals ? `, ${fmt(costTotals.costValue)} at today's cost` : ""}
              </div>
            </div>
            <div className="rounded-lg border border-brand-gray/20 bg-white p-4 shadow-sm">
              <div className="text-xs uppercase tracking-wide text-brand-gray">Arrived</div>
              <div className="mt-1 text-2xl font-semibold text-brand-navy">
                {qtyFmt.format(data.totals.received)} units
              </div>
            </div>
            <div className="rounded-lg border border-brand-gray/20 bg-white p-4 shadow-sm">
              <div className="text-xs uppercase tracking-wide text-brand-gray">On the way now</div>
              <div className="mt-1 text-2xl font-semibold text-brand-navy">
                {qtyFmt.format(data.inTransitNow.units)} units
              </div>
              <div className="text-xs text-brand-gray">
                {data.inTransitNow.oldestDays === null
                  ? "Nothing on its way"
                  : `${transfersText(data.inTransitNow.transfers)}, the oldest sent ${qtyFmt.format(data.inTransitNow.oldestDays)} days ago`}
              </div>
            </div>
          </div>

          {data.costVisible === false && <CostHiddenNote />}
          {data.totals.transfers === 0 && (
            <p className="text-sm text-brand-gray">No transfers match.</p>
          )}

          {data.routes.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-lg font-semibold text-brand-navy">By route</h2>
              <div className="overflow-x-auto rounded-lg border border-brand-gray/20 bg-white shadow-md">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-brand-gray/20 bg-brand-linen">
                      <th className="px-4 py-3 text-left font-semibold text-brand-gray">From</th>
                      <th className="px-4 py-3 text-left font-semibold text-brand-gray">To</th>
                      <th className="px-4 py-3 text-right font-semibold text-brand-gray">
                        Transfers
                      </th>
                      <th className="px-4 py-3 text-right font-semibold text-brand-gray">Units</th>
                      <th className="px-4 py-3 text-right font-semibold text-brand-gray">
                        Arrived
                      </th>
                      {costTotals && (
                        <th className="px-4 py-3 text-right font-semibold text-brand-gray">
                          Today&apos;s cost
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {data.routes.map((r, i) => (
                      <tr
                        key={`${r.from}|${r.to}`}
                        className={`border-b border-brand-gray/10 ${i % 2 === 1 ? "bg-brand-stripe" : ""}`}
                      >
                        <td className="px-4 py-3 text-brand-navy">{r.from}</td>
                        <td className="px-4 py-3 text-brand-navy">{r.to}</td>
                        <td className="px-4 py-3 text-right text-brand-gray">
                          {qtyFmt.format(r.transfers)}
                        </td>
                        <td className="px-4 py-3 text-right text-brand-gray">
                          {qtyFmt.format(r.units)}
                        </td>
                        <td className="px-4 py-3 text-right text-brand-gray">
                          {qtyFmt.format(r.received)}
                        </td>
                        {"costValue" in r && (
                          <td className="px-4 py-3 text-right text-brand-gray">
                            {fmt(r.costValue)}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {data.rows.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-lg font-semibold text-brand-navy">Transfers</h2>
              {data.rows.length < data.totals.transfers && (
                <p className="text-xs text-brand-gray">
                  The latest {qtyFmt.format(data.rows.length)} of{" "}
                  {qtyFmt.format(data.totals.transfers)}. The totals above cover all of them.
                </p>
              )}
              <div className="overflow-x-auto rounded-lg border border-brand-gray/20 bg-white shadow-md">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-brand-gray/20 bg-brand-linen">
                      <th className="px-4 py-3 text-left font-semibold text-brand-gray">Sent</th>
                      <th className="px-4 py-3 text-left font-semibold text-brand-gray">Product</th>
                      <th className="px-4 py-3 text-left font-semibold text-brand-gray">Route</th>
                      <th className="px-4 py-3 text-right font-semibold text-brand-gray">Units</th>
                      <th className="px-4 py-3 text-left font-semibold text-brand-gray">Status</th>
                      {costTotals && (
                        <th className="px-4 py-3 text-right font-semibold text-brand-gray">
                          Today&apos;s cost
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((t, i) => (
                      <tr
                        key={t.id}
                        className={`border-b border-brand-gray/10 ${i % 2 === 1 ? "bg-brand-stripe" : ""}`}
                      >
                        <td className="whitespace-nowrap px-4 py-3 text-brand-gray">
                          <Link
                            href={`/app/warehouse/transfers/${t.id}`}
                            className="hover:underline"
                          >
                            {t.sentOn}
                          </Link>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-semibold text-brand-navy">{t.productName}</div>
                          <div className="text-xs text-brand-gray">{t.productNumber}</div>
                        </td>
                        <td className="px-4 py-3 text-brand-gray">
                          <div>
                            {t.from}
                            {t.fromPlace ? ` (${t.fromPlace})` : ""}
                          </div>
                          <div>
                            to {t.to}
                            {t.toPlace ? ` (${t.toPlace})` : ""}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right text-brand-gray">
                          {qtyFmt.format(t.quantity)}
                        </td>
                        <td className="px-4 py-3 text-brand-gray">
                          <div>{TRANSFER_STATUS_LABELS[t.status] ?? t.status}</div>
                          {t.daysOnTheWay !== null && (
                            <div className="text-xs">
                              {qtyFmt.format(t.daysOnTheWay)} days
                              {t.received > 0 ? `, ${qtyFmt.format(t.received)} arrived` : ""}
                            </div>
                          )}
                          {t.receivedOn && <div className="text-xs">{t.receivedOn}</div>}
                        </td>
                        {"costValue" in t && (
                          <td className="px-4 py-3 text-right text-brand-gray">
                            {fmt(t.costValue)}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
