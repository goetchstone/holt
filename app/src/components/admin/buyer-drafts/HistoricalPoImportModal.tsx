// /app/src/components/admin/buyer-drafts/HistoricalPoImportModal.tsx
//
// Slice 6.13 (2026-05-22) — Modal for importing an existing real
// PurchaseOrder into a BuyerDraftBuy so Slice 6 performance reports
// can run against historical buys.
//
// UX: search by PON / vendor / date range → list of matches with
// "already imported" flag → click row → confirm prompt → POST to the
// import endpoint → success toast + onImported callback.
//
// Built on Headless UI Dialog per the project's a11y pattern.

import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";
import { X, Search } from "lucide-react";

interface PoSearchResult {
  id: number;
  poNumber: string;
  orderDate: string;
  status: string;
  expectedDelivery: string | null;
  estimatedShipDate: string | null;
  vendor: { id: number; name: string };
  lineCount: number;
  alreadyImported: {
    draftPoId: number;
    buyId: number | null;
    buyName: string | null;
  } | null;
}

interface SiblingSuggestion {
  id: number;
  poNumber: string;
  orderDate: string;
  vendor: { id: number; name: string };
  status: string;
  lineCount: number;
  overlapCount: number;
  fullyContainedBySource: boolean;
}

interface Props {
  open: boolean;
  buyId: number | null;
  buyName: string | null;
  onClose: () => void;
  onImported: () => void;
}

export function HistoricalPoImportModal({
  open,
  buyId,
  buyName,
  onClose,
  onImported,
}: Readonly<Props>) {
  const [query, setQuery] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [results, setResults] = useState<PoSearchResult[]>([]);
  const [capped, setCapped] = useState(false);
  const [searching, setSearching] = useState(false);
  const [importingId, setImportingId] = useState<number | null>(null);
  // Sibling suggestions appear after a successful import. The buyer can
  // import each suggestion with one click to stitch a split-receive
  // chain back together.
  const [siblings, setSiblings] = useState<SiblingSuggestion[]>([]);
  const [lastImportedPoNumber, setLastImportedPoNumber] = useState<string | null>(null);

  // Reset state on every open.
  useEffect(() => {
    if (open) {
      setQuery("");
      setStartDate("");
      setEndDate("");
      setResults([]);
      setCapped(false);
      setSearching(false);
      setImportingId(null);
      setSiblings([]);
      setLastImportedPoNumber(null);
    }
  }, [open]);

  const canSearch = query.trim().length >= 2 || startDate !== "" || endDate !== "";

  async function handleSearch(e: { preventDefault: () => void }) {
    e.preventDefault();
    if (!canSearch) return;
    setSearching(true);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (startDate) params.set("startDate", startDate);
      if (endDate) params.set("endDate", endDate);
      const res = await fetch(`/api/admin/buyer-drafts/search-purchase-orders?${params}`);
      const data = (await res.json()) as {
        results?: PoSearchResult[];
        capped?: boolean;
        error?: string;
      };
      if (!res.ok) {
        toast.error(data.error ?? "Search failed");
        return;
      }
      setResults(data.results ?? []);
      setCapped(Boolean(data.capped));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Search failed");
    } finally {
      setSearching(false);
    }
  }

  async function handleImport(po: PoSearchResult) {
    if (!buyId) return;
    if (po.alreadyImported) {
      toast.warning(`Already imported into ${po.alreadyImported.buyName ?? "another buy"}.`);
      return;
    }
    const confirmed = globalThis.confirm(
      `Import PON ${po.poNumber} (${po.lineCount} item${po.lineCount === 1 ? "" : "s"}) from ${po.vendor.name} into "${buyName ?? "this buy"}"?`,
    );
    if (!confirmed) return;
    setImportingId(po.id);
    try {
      const res = await fetch("/api/admin/buyer-drafts/import-purchase-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buyId, purchaseOrderId: po.id }),
      });
      const data = (await res.json()) as {
        itemsImported?: number;
        skipped?: ReadonlyArray<{ partNo: string | null }>;
        error?: string;
      };
      if (!res.ok) {
        toast.error(data.error ?? "Import failed");
        return;
      }
      const skippedCount = data.skipped?.length ?? 0;
      const msg =
        skippedCount > 0
          ? `Imported ${data.itemsImported ?? 0} items (${skippedCount} skipped — no Product link)`
          : `Imported ${data.itemsImported ?? 0} items from PON ${po.poNumber}`;
      toast.success(msg);
      onImported();
      // Update the search result row so the user can see "already imported" without re-searching
      setResults((prev) =>
        prev.map((r) =>
          r.id === po.id
            ? {
                ...r,
                alreadyImported: {
                  draftPoId: 0,
                  buyId,
                  buyName,
                },
              }
            : r,
        ),
      );
      // Fetch sibling suggestions — the POS partial-receive workflow
      // splits a PO into the original + a NEW remainder PO. Surface
      // candidates so the buyer can stitch the chain back together.
      void fetchSiblings(po.id, po.poNumber);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImportingId(null);
    }
  }

  async function fetchSiblings(sourcePoId: number, sourcePoNumber: string) {
    try {
      const res = await fetch(
        `/api/admin/buyer-drafts/find-sibling-pos?purchaseOrderId=${sourcePoId}`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as { suggestions?: SiblingSuggestion[] };
      const list = data.suggestions ?? [];
      if (list.length === 0) {
        setSiblings([]);
        setLastImportedPoNumber(null);
        return;
      }
      setSiblings(list);
      setLastImportedPoNumber(sourcePoNumber);
    } catch {
      // Sibling lookup is a nicety, never block the main flow on its failure
      setSiblings([]);
    }
  }

  async function handleImportSibling(sibling: SiblingSuggestion) {
    if (!buyId) return;
    setImportingId(sibling.id);
    try {
      const res = await fetch("/api/admin/buyer-drafts/import-purchase-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buyId, purchaseOrderId: sibling.id }),
      });
      const data = (await res.json()) as {
        itemsImported?: number;
        skipped?: ReadonlyArray<unknown>;
        error?: string;
      };
      if (!res.ok) {
        toast.error(data.error ?? "Import failed");
        return;
      }
      toast.success(`Imported ${data.itemsImported ?? 0} items from PON ${sibling.poNumber}`);
      onImported();
      // Remove the imported sibling from the suggestion list + fetch the
      // next ring (a sibling of a sibling might be the third PON in a
      // 3-way split).
      setSiblings((prev) => prev.filter((s) => s.id !== sibling.id));
      void fetchSiblings(sibling.id, sibling.poNumber);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImportingId(null);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-black/50" />
      <div className="fixed inset-0 flex items-start justify-center overflow-y-auto p-4 pt-12">
        <DialogPanel className="w-full max-w-3xl rounded bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-sh-stripe px-5 py-4">
            <DialogTitle className="text-lg font-semibold text-sh-navy">
              Import historical PO into {buyName ?? "buy"}
            </DialogTitle>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="min-h-[44px] min-w-[44px] flex items-center justify-center text-sh-gray hover:text-sh-navy"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="p-5 space-y-4">
            <p className="text-sm text-sh-gray">
              Search for a real PurchaseOrder by PON or vendor name, then click Import to add its
              line items to this buy as draft items linked to the catalog. Useful for testing
              sell-through, dead stock, and budget reports against past buys without re-typing
              items.
            </p>

            {siblings.length > 0 && lastImportedPoNumber && (
              <div className="border border-sh-gold/40 bg-sh-gold/10 rounded p-3 space-y-2">
                <div className="text-sm font-semibold text-sh-navy">
                  Likely sibling POs of PON {lastImportedPoNumber}
                </div>
                <p className="text-xs text-sh-gray">
                  the POS splits a PO into a new PON when a partial-receive cancels the remainder.
                  These candidates share items with what you just imported — same vendor, within 90
                  days. Import each to stitch the chain back together.
                </p>
                <ul className="space-y-1">
                  {siblings.map((s) => (
                    <li
                      key={s.id}
                      className="flex items-center justify-between bg-white border border-sh-stripe rounded px-3 py-2 text-sm"
                    >
                      <div className="flex items-baseline gap-2 min-w-0">
                        <span className="font-mono text-sh-navy">{s.poNumber}</span>
                        <span className="text-xs text-sh-gray truncate">
                          {s.vendor.name} · {s.orderDate.slice(0, 10)} · {s.lineCount} lines ·{" "}
                          {s.overlapCount} overlap
                          {s.fullyContainedBySource ? " · fully contained" : ""}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleImportSibling(s)}
                        disabled={importingId === s.id}
                        className="px-3 py-1 bg-sh-blue text-white rounded text-xs disabled:bg-sh-gray min-h-[36px]"
                      >
                        {importingId === s.id ? "Importing…" : "Import"}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <form onSubmit={handleSearch} className="space-y-3">
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-sh-gray" />
                  <label htmlFor="historical-po-q" className="sr-only">
                    Search PON or vendor
                  </label>
                  <input
                    id="historical-po-q"
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="PON12345 or vendor name (2+ chars)"
                    className="w-full pl-10 pr-3 py-2 border border-sh-stripe rounded"
                  />
                </div>
                <button
                  type="submit"
                  disabled={!canSearch || searching}
                  className="px-4 py-2 bg-sh-navy text-white rounded disabled:bg-sh-gray disabled:cursor-not-allowed"
                >
                  {searching ? "Searching…" : "Search"}
                </button>
              </div>
              <div className="flex gap-3 text-sm">
                <div className="flex-1">
                  <label htmlFor="historical-po-start" className="block text-xs text-sh-gray">
                    Order date from
                  </label>
                  <input
                    id="historical-po-start"
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-full px-2 py-1 border border-sh-stripe rounded"
                  />
                </div>
                <div className="flex-1">
                  <label htmlFor="historical-po-end" className="block text-xs text-sh-gray">
                    To
                  </label>
                  <input
                    id="historical-po-end"
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="w-full px-2 py-1 border border-sh-stripe rounded"
                  />
                </div>
              </div>
            </form>

            <div className="border border-sh-stripe rounded max-h-[50vh] overflow-y-auto">
              {results.length === 0 ? (
                <div className="p-6 text-center text-sm text-sh-gray">
                  {searching ? "Searching…" : "Enter a search and click Search."}
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-sh-stripe/40 text-xs uppercase tracking-wide text-sh-gray">
                    <tr>
                      <th className="text-left px-3 py-2">PON</th>
                      <th className="text-left px-3 py-2">Vendor</th>
                      <th className="text-left px-3 py-2">Order date</th>
                      <th className="text-right px-3 py-2">Lines</th>
                      <th className="text-left px-3 py-2">Status</th>
                      <th className="text-right px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((po) => {
                      const isAlready = po.alreadyImported !== null;
                      return (
                        <tr key={po.id} className="border-t border-sh-stripe">
                          <td className="px-3 py-2 font-mono text-sh-navy">{po.poNumber}</td>
                          <td className="px-3 py-2">{po.vendor.name}</td>
                          <td className="px-3 py-2">{po.orderDate.slice(0, 10)}</td>
                          <td className="px-3 py-2 text-right">{po.lineCount}</td>
                          <td className="px-3 py-2 text-xs text-sh-gray">{po.status}</td>
                          <td className="px-3 py-2 text-right">
                            {isAlready ? (
                              <span className="text-xs text-sh-gray italic">
                                In {po.alreadyImported?.buyName ?? "another buy"}
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleImport(po)}
                                disabled={importingId === po.id}
                                className="px-3 py-1 bg-sh-blue text-white rounded text-xs disabled:bg-sh-gray min-h-[36px]"
                              >
                                {importingId === po.id ? "Importing…" : "Import"}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            {capped && (
              <div className="text-xs text-sh-gray">
                Showing first 50 matches. Refine the search if your PO isn&apos;t here.
              </div>
            )}
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
