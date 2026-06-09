"use client";

// /app/src/app/(dashboard)/app/sales/till/TillView.tsx
//
// Till open/close register body -- App Router port of the legacy
// pages/sales/till.tsx (minus MainLayout chrome, which the (dashboard) layout
// supplies). Register selection, denomination counts, open-till summaries,
// close-out, and recent history all read/write the shared /api/registers +
// /api/tills REST endpoints exactly as before. Money is shown via
// useMoneyFormatter (till precision shows cents); the count totals come from
// DenominationCountTable's calcTotal helper unchanged.

import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useActiveStore } from "@/hooks/useActiveStore";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";
import DenominationCountTable, {
  DENOMINATIONS,
  calcTotal,
  toCountEntries,
} from "@/components/sales/DenominationCountTable";

interface Register {
  id: number;
  name: string;
  isActive: boolean;
  storeLocation: { name: string; code: string };
}

interface TillSummaryCount {
  denomination: string;
  quantity: number;
  amount: number;
}

interface TillSummary {
  cash: number;
  card: number;
  check: number;
  giftCard: number;
  storeCredit: number;
  other: number;
  total: number;
  expectedCash: number;
  openingCash: number;
  actualCash: number | null;
  variance: number | null;
  paymentCount: number;
  openingCounts?: TillSummaryCount[];
  closingCounts?: TillSummaryCount[];
}

interface OpenTill {
  id: number;
  registerId: number;
  openingCash: number;
  openedAt: string;
  register: { name: string; storeLocation: { name: string } };
  openedBy: { displayName: string };
}

interface ClosedResult {
  id: number;
  variance: number | null;
}

interface HistoryTill {
  id: number;
  status: string;
  openedAt: string;
  closedAt: string | null;
  openingCash: number;
  expectedCash: number | null;
  actualCash: number | null;
  variance: number | null;
  register: { name: string; storeLocation: { name: string; code: string } };
  openedBy: { displayName: string };
  closedBy: { displayName: string } | null;
  _count: { payments: number };
}

type MoneyFmt = ReturnType<typeof useMoneyFormatter>;

// Variance is green at exactly zero, red otherwise, gray when not yet known.
// Extracted so the JSX below stays free of nested ternaries (S3358).
function varianceClass(variance: number | null): string {
  if (variance == null) return "text-sh-gray";
  return variance === 0 ? "text-green-600" : "text-red-600";
}

function fmtDate(iso: string | null): string {
  if (!iso) return "--";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ── Open-till card ─────────────────────────────────────────────────────────────

function OpenTillCard({
  till,
  summary,
  fmt,
  onRefresh,
  onClose,
}: Readonly<{
  till: OpenTill;
  summary: TillSummary | undefined;
  fmt: MoneyFmt;
  onRefresh: (tillId: number) => void;
  onClose: (tillId: number) => void;
}>) {
  const methods = summary
    ? [
        { label: "Cash", value: summary.cash },
        { label: "Card", value: summary.card },
        { label: "Check", value: summary.check },
        { label: "Gift Card", value: summary.giftCard },
        { label: "Store Credit", value: summary.storeCredit },
        { label: "Other", value: summary.other },
      ]
    : [];

  return (
    <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-sh-black">{till.register.name}</h3>
          <p className="text-sm text-sh-gray">
            {till.register.storeLocation.name} -- Opened by {till.openedBy.displayName} at{" "}
            {fmtDate(till.openedAt)}
          </p>
        </div>
        <span className="text-xs px-2 py-0.5 rounded bg-green-50 text-green-700">Open</span>
      </div>

      {summary && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
            {methods.map((m) => (
              <div key={m.label} className="border border-sh-gray/10 rounded p-3 text-center">
                <p className="text-xs text-sh-gray">{m.label}</p>
                <p className="text-lg text-sh-black font-medium">{fmt(m.value)}</p>
              </div>
            ))}
          </div>

          <div className="border-t border-sh-gray/10 pt-3 flex items-center justify-between">
            <div className="space-y-1">
              <p className="text-sm text-sh-gray">
                Opening Cash:{" "}
                <span className="text-sh-black font-medium">{fmt(summary.openingCash)}</span>
              </p>
              <p className="text-sm text-sh-gray">
                Expected Cash:{" "}
                <span className="text-sh-black font-medium">{fmt(summary.expectedCash)}</span>
              </p>
              <p className="text-sm text-sh-gray">
                Total: <span className="text-sh-black font-medium">{fmt(summary.total)}</span>
              </p>
              <p className="text-sm text-sh-gray">
                Payments: <span className="text-sh-black">{summary.paymentCount}</span>
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => onRefresh(till.id)}>
                Refresh
              </Button>
              <Button size="sm" onClick={() => onClose(till.id)}>
                Close Till
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── History table ──────────────────────────────────────────────────────────────

function HistoryTable({ history, fmt }: Readonly<{ history: HistoryTill[]; fmt: MoneyFmt }>) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-sh-gray border-b border-sh-gray/10">
            <th className="py-2 pr-4 font-medium">Register</th>
            <th className="py-2 pr-4 font-medium">Opened</th>
            <th className="py-2 pr-4 font-medium">Closed</th>
            <th className="py-2 pr-4 font-medium text-right">Opening</th>
            <th className="py-2 pr-4 font-medium text-right">Expected</th>
            <th className="py-2 pr-4 font-medium text-right">Actual</th>
            <th className="py-2 pr-4 font-medium text-right">Variance</th>
            <th className="py-2 font-medium text-right">Payments</th>
          </tr>
        </thead>
        <tbody>
          {history.map((t) => (
            <tr key={t.id} className="border-b border-sh-gray/5 hover:bg-sh-stripe cursor-pointer">
              <td className="py-2 pr-4">
                <Link href={`/app/sales/till/${t.id}`} className="text-sh-blue hover:underline">
                  {t.register.name}
                </Link>
              </td>
              <td className="py-2 pr-4 text-sh-gray">{fmtDate(t.openedAt)}</td>
              <td className="py-2 pr-4 text-sh-gray">{fmtDate(t.closedAt)}</td>
              <td className="py-2 pr-4 text-right">{fmt(t.openingCash)}</td>
              <td className="py-2 pr-4 text-right">{fmt(t.expectedCash)}</td>
              <td className="py-2 pr-4 text-right">{fmt(t.actualCash)}</td>
              <td className={`py-2 pr-4 text-right font-medium ${varianceClass(t.variance)}`}>
                {fmt(t.variance)}
              </td>
              <td className="py-2 text-right text-sh-gray">{t._count.payments}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function TillView() {
  const { activeStore, allStores, setActiveStore, loading: storeLoading } = useActiveStore();
  const fmt = useMoneyFormatter();

  const [initialLoading, setInitialLoading] = useState(true);
  const [registers, setRegisters] = useState<Register[]>([]);
  const [selectedRegisterId, setSelectedRegisterId] = useState("");
  const [openingCounts, setOpeningCounts] = useState<Record<string, number>>({});
  const [tillDate, setTillDate] = useState(new Date().toISOString().slice(0, 10));
  const [openTills, setOpenTills] = useState<OpenTill[]>([]);
  const [summaries, setSummaries] = useState<Record<number, TillSummary>>({});
  const [closingTillId, setClosingTillId] = useState<number | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [closeNotes, setCloseNotes] = useState("");
  const [closedResult, setClosedResult] = useState<ClosedResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<HistoryTill[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const fetchRegisters = useCallback(async (storeId: number) => {
    try {
      const res = await axios.get(`/api/registers?storeLocationId=${storeId}&limit=100`);
      const active = (res.data.registers as Register[]).filter((r) => r.isActive);
      setRegisters(active);
    } catch {
      toast.error("Failed to load registers");
    }
  }, []);

  const fetchHistory = useCallback(async (storeId: number) => {
    setHistoryLoading(true);
    try {
      const res = await axios.get(`/api/tills?storeLocationId=${storeId}&status=CLOSED&limit=10`);
      setHistory(res.data.tills || []);
    } catch {
      // Non-critical -- silently fail
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const fetchOpenTills = useCallback(async (storeId: number) => {
    try {
      const res = await axios.get(`/api/tills?storeLocationId=${storeId}&status=OPEN&limit=50`);
      const tills: OpenTill[] = res.data.tills || [];
      setOpenTills(tills);

      // Fetch summaries for all open tills in parallel
      const summaryEntries = await Promise.all(
        tills.map(async (t) => {
          try {
            const sRes = await axios.get(`/api/tills/${t.id}/summary`);
            return [t.id, sRes.data as TillSummary] as const;
          } catch {
            return null;
          }
        }),
      );

      const newSummaries: Record<number, TillSummary> = {};
      for (const entry of summaryEntries) {
        if (entry) newSummaries[entry[0]] = entry[1];
      }
      setSummaries(newSummaries);
    } catch {
      setOpenTills([]);
      setSummaries({});
    }
  }, []);

  // When the active store changes, reload registers and check for open tills
  useEffect(() => {
    if (storeLoading || !activeStore) return;

    const init = async () => {
      setInitialLoading(true);
      setClosingTillId(null);
      setClosedResult(null);
      await fetchRegisters(activeStore.id);
      await fetchOpenTills(activeStore.id);
      fetchHistory(activeStore.id);
      setInitialLoading(false);
    };
    init();
  }, [activeStore, storeLoading, fetchRegisters, fetchOpenTills, fetchHistory]);

  // Auto-select register when there's only one available (not already open)
  useEffect(() => {
    const openRegisterIds = new Set(openTills.map((t) => t.registerId));
    const available = registers.filter((r) => !openRegisterIds.has(r.id));
    if (available.length === 1) {
      setSelectedRegisterId(String(available[0].id));
    } else {
      setSelectedRegisterId("");
    }
  }, [registers, openTills]);

  const handleStoreChange = async (storeId: number) => {
    try {
      await setActiveStore(storeId);
    } catch {
      toast.error("Failed to switch store");
    }
  };

  const handleOpenTill = async () => {
    if (!selectedRegisterId) {
      toast.error("Select a register");
      return;
    }
    const countEntries = toCountEntries(openingCounts);
    const cashAmount = calcTotal(openingCounts);

    setSaving(true);
    try {
      const res = await axios.post(`/api/registers/${selectedRegisterId}/tills/open`, {
        openingCash: cashAmount,
        counts: countEntries,
        tillDate,
      });
      const newTill: OpenTill = res.data;

      // Fetch summary for the new till
      const summaryRes = await axios.get(`/api/tills/${newTill.id}/summary`);
      setSummaries((prev) => ({ ...prev, [newTill.id]: summaryRes.data }));
      setOpenTills((prev) => [...prev, newTill]);
      setOpeningCounts({});
      setSelectedRegisterId("");
      toast.success(`Till opened on ${newTill.register.name}`);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to open till"));
    } finally {
      setSaving(false);
    }
  };

  const refreshSummary = async (tillId: number) => {
    try {
      const res = await axios.get(`/api/tills/${tillId}/summary`);
      setSummaries((prev) => ({ ...prev, [tillId]: res.data }));
    } catch {
      toast.error("Failed to refresh summary");
    }
  };

  const startClose = (tillId: number) => {
    const initial: Record<string, number> = {};
    for (const d of DENOMINATIONS) {
      initial[d.label] = 0;
    }
    setCounts(initial);
    setCloseNotes("");
    setClosingTillId(tillId);
  };

  const handleClose = async () => {
    if (!closingTillId) return;

    const actualCash = calcTotal(counts);
    const countEntries = toCountEntries(counts);

    setSaving(true);
    try {
      const res = await axios.post(`/api/tills/${closingTillId}/close`, {
        counts: countEntries,
        actualCash,
        notes: closeNotes || undefined,
      });
      setClosedResult({ id: res.data.id, variance: res.data.variance });
      setOpenTills((prev) => prev.filter((t) => t.id !== closingTillId));
      setSummaries((prev) => {
        const next = { ...prev };
        delete next[closingTillId];
        return next;
      });
      setClosingTillId(null);
      if (activeStore) fetchHistory(activeStore.id);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to close till"));
    } finally {
      setSaving(false);
    }
  };

  const dismissClosedResult = () => {
    setClosedResult(null);
  };

  const closingTill = closingTillId ? openTills.find((t) => t.id === closingTillId) : null;

  return (
    <div className="py-2 space-y-6 font-serif">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl text-sh-blue font-semibold">Till</h1>

        {/* Store selector */}
        {allStores.length > 1 && (
          <select
            value={activeStore?.id ?? ""}
            onChange={(e) => handleStoreChange(Number.parseInt(e.target.value))}
            className="border border-sh-gray/30 rounded px-3 py-1.5 text-sm"
            aria-label="Active store"
          >
            {allStores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {(initialLoading || storeLoading) && <p className="text-sh-gray">Loading...</p>}

      {!storeLoading && !activeStore && (
        <p className="text-sh-gray">No active store selected. Choose a store to continue.</p>
      )}

      {/* Closed result banner */}
      {closedResult && (
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6 space-y-4 max-w-md">
          <h2 className="text-lg font-semibold text-sh-black">Till Closed</h2>

          <div className="text-center py-4">
            <p className="text-sm text-sh-gray mb-1">Variance</p>
            <p className={`text-3xl font-semibold ${varianceClass(closedResult.variance)}`}>
              {fmt(closedResult.variance)}
            </p>
          </div>

          <div className="flex gap-3 justify-center">
            <Link href={`/app/sales/till/${closedResult.id}`}>
              <Button variant="outline" size="sm">
                View Details
              </Button>
            </Link>
            <Button size="sm" onClick={dismissClosedResult}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {/* Open tills grouped by register */}
      {!initialLoading && activeStore && openTills.length > 0 && !closingTillId && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-sh-black">Open Tills ({openTills.length})</h2>

          {openTills.map((till) => (
            <OpenTillCard
              key={till.id}
              till={till}
              summary={summaries[till.id]}
              fmt={fmt}
              onRefresh={refreshSummary}
              onClose={startClose}
            />
          ))}
        </div>
      )}

      {/* Closing phase -- denomination count for a specific till */}
      {closingTillId && closingTill && (
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6 space-y-4">
          <h2 className="text-lg font-semibold text-sh-black">
            Count Drawer -- {closingTill.register.name}
          </h2>
          <p className="text-sm text-sh-gray">
            Enter the quantity of each denomination in the drawer.
          </p>

          <DenominationCountTable counts={counts} onChange={setCounts} />

          <div>
            <label htmlFor="till-close-notes" className="block text-sm text-sh-gray mb-1">
              Notes
            </label>
            <textarea
              id="till-close-notes"
              value={closeNotes}
              onChange={(e) => setCloseNotes(e.target.value)}
              className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
              rows={3}
              placeholder="Optional notes..."
            />
          </div>

          <div className="flex gap-3">
            <Button onClick={handleClose} disabled={saving}>
              {saving ? "Closing..." : "Submit Close"}
            </Button>
            <Button variant="outline" onClick={() => setClosingTillId(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Open new till form -- shown when there are available registers */}
      {!initialLoading && activeStore && !closingTillId && (
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6 space-y-4">
          <h2 className="text-lg font-semibold text-sh-black">Open Till</h2>

          {registers.length === 0 ? (
            <p className="text-sm text-sh-gray">
              No active registers found for {activeStore.name}.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-md">
                <div>
                  <label htmlFor="till-register" className="block text-sm text-sh-gray mb-1">
                    Register
                  </label>
                  <select
                    id="till-register"
                    value={selectedRegisterId}
                    onChange={(e) => setSelectedRegisterId(e.target.value)}
                    className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
                  >
                    <option value="">Select a register...</option>
                    {registers.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="till-date" className="block text-sm text-sh-gray mb-1">
                    Date
                  </label>
                  <input
                    id="till-date"
                    type="date"
                    value={tillDate}
                    onChange={(e) => setTillDate(e.target.value)}
                    className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div>
                <p className="text-sm text-sh-gray mb-2">
                  Count the drawer before opening. Total becomes the opening cash.
                </p>
                <DenominationCountTable
                  counts={openingCounts}
                  onChange={setOpeningCounts}
                  totalLabel="Opening Cash Total"
                />
              </div>

              <Button onClick={handleOpenTill} disabled={saving || !selectedRegisterId}>
                {saving ? "Opening..." : "Open Till"}
              </Button>
            </>
          )}
        </div>
      )}

      {/* Till History */}
      {activeStore && !storeLoading && !initialLoading && (
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
          <h2 className="text-lg font-semibold text-sh-black mb-4">Recent Tills</h2>

          {historyLoading && <p className="text-sm text-sh-gray">Loading history...</p>}

          {!historyLoading && history.length === 0 && (
            <p className="text-sm text-sh-gray">No closed tills found for this store.</p>
          )}

          {!historyLoading && history.length > 0 && <HistoryTable history={history} fmt={fmt} />}
        </div>
      )}
    </div>
  );
}
