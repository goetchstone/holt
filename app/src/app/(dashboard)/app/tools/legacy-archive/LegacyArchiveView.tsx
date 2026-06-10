"use client";

// /app/src/app/(dashboard)/app/tools/legacy-archive/LegacyArchiveView.tsx
//
// Legacy Archive lookup: one search box (name / company / phone / address /
// order #), paginated result cards, expandable line items. Read-only by
// design — no edit affordances anywhere. Archive meta (order count + date
// range) renders up front so staff know what period the archive covers.

import { useState } from "react";
import { Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";

function fmtDate(iso: string | null): string {
  if (!iso) return "--";
  return new Date(iso).toLocaleDateString("en-US", { timeZone: "UTC" });
}

export function LegacyArchiveView() {
  const money = useMoneyFormatter();
  const [input, setInput] = useState("");
  const [committed, setCommitted] = useState("");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const query = api.legacyArchive.search.useQuery({ search: committed, page });
  const data = query.data;
  const loading = query.isFetching;

  const run = () => {
    setPage(1);
    setExpanded(new Set());
    setCommitted(input.trim());
  };

  const toggle = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="max-w-4xl space-y-6 font-serif">
      <div>
        <h1 className="text-2xl font-semibold text-sh-navy">Legacy Archive</h1>
        <p className="text-sm text-sh-gray">
          Historical sales imported from a previous system. Read-only — nothing here feeds reports
          or live data.
          {data?.meta && data.meta.archiveOrders > 0 && (
            <>
              {" "}
              {data.meta.archiveOrders.toLocaleString("en-US")} orders,{" "}
              {fmtDate(data.meta.earliest)} – {fmtDate(data.meta.latest)}.
            </>
          )}
        </p>
      </div>

      <div className="flex gap-3">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") run();
          }}
          placeholder="Name, company, phone, address, or order #..."
          aria-label="Search the legacy archive"
          className="min-h-[44px] flex-1 rounded border border-gray-300 px-3 text-sm"
        />
        <button
          type="button"
          onClick={run}
          disabled={loading || input.trim().length === 0}
          className="min-h-[44px] rounded-lg bg-sh-navy px-6 text-sm font-semibold text-white transition hover:bg-sh-blue disabled:opacity-50"
        >
          {loading ? "Searching..." : "Search"}
        </button>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-sh-gold" />
        </div>
      )}

      {data && !loading && committed && data.orders.length === 0 && (
        <p className="py-12 text-center text-sh-gray">No archive orders match that search.</p>
      )}

      {data && !loading && data.orders.length > 0 && (
        <>
          <p className="text-sm text-sh-gray">
            {data.total.toLocaleString("en-US")} match{data.total === 1 ? "" : "es"}
          </p>
          <div className="space-y-3">
            {data.orders.map((o) => (
              <div
                key={o.id}
                className="overflow-hidden rounded-lg border border-sh-gray/20 bg-white shadow-sm"
              >
                <button
                  type="button"
                  onClick={() => toggle(o.id)}
                  className="flex w-full items-start justify-between gap-4 px-4 py-3 text-left hover:bg-sh-linen"
                >
                  <div>
                    <div className="font-semibold text-sh-navy">
                      {o.customerName || o.companyName || "(no name)"}
                      {o.companyName && o.customerName && o.companyName !== o.customerName ? (
                        <span className="font-normal text-sh-gray"> · {o.companyName}</span>
                      ) : null}
                      {o.customerCode ? (
                        <span className="ml-2 rounded-full bg-sh-stripe px-2 py-0.5 text-xs text-sh-gray">
                          {o.customerCode}
                        </span>
                      ) : null}
                    </div>
                    <div className="text-sm text-sh-gray">
                      {o.orderNumber} · {fmtDate(o.saleDate)}
                      {o.phone ? ` · ${o.phone}` : ""}
                    </div>
                    {(o.address || o.city) && (
                      <div className="text-xs text-sh-gray">
                        {[o.address, [o.city, o.state].filter(Boolean).join(", "), o.zip]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-semibold text-sh-navy">
                      {o.grandTotal === null ? "--" : money(o.grandTotal)}
                    </span>
                    {expanded.has(o.id) ? (
                      <ChevronDown className="h-4 w-4 text-sh-gray" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-sh-gray" />
                    )}
                  </div>
                </button>
                {expanded.has(o.id) && (
                  <table className="w-full border-t border-sh-gray/10 text-sm">
                    <thead>
                      <tr className="bg-sh-linen text-left text-xs text-sh-gray">
                        <th className="px-4 py-2 font-semibold">SKU</th>
                        <th className="px-4 py-2 font-semibold">Description</th>
                        <th className="px-4 py-2 font-semibold">Vendor</th>
                        <th className="px-4 py-2 font-semibold">Notes</th>
                        <th className="px-4 py-2 text-right font-semibold">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {o.lines.map((l) => (
                        <tr key={l.id} className="border-t border-sh-gray/10">
                          <td className="px-4 py-2 text-sh-gray">{l.sku || "--"}</td>
                          <td className="px-4 py-2">{l.description || "--"}</td>
                          <td className="px-4 py-2 text-sh-gray">
                            {[l.vendor, l.vendorSku].filter(Boolean).join(" · ") ||
                              l.manufacturer ||
                              "--"}
                          </td>
                          <td className="px-4 py-2 text-xs text-sh-gray">{l.misc || ""}</td>
                          <td className="px-4 py-2 text-right">
                            {l.lineTotal === null ? "--" : money(l.lineTotal)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-4">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1 || loading}
                className="min-h-[44px] rounded border border-gray-300 px-4 text-sm disabled:opacity-40"
              >
                Previous
              </button>
              <span className="text-sm text-sh-gray">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages || loading}
                className="min-h-[44px] rounded border border-gray-300 px-4 text-sm disabled:opacity-40"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}

      {!committed && !loading && (
        <p className="py-12 text-center text-sh-gray">
          Search by customer name, company, phone, address, or order number.
        </p>
      )}
    </div>
  );
}
