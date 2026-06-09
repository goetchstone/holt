"use client";

// /app/src/app/(dashboard)/app/inventory/freeze/FreezeView.tsx
//
// Inventory Freeze body: list of point-in-time inventory snapshots with create /
// cancel / expand-detail, plus a compare-two-freezes mode. App Router port of
// the legacy pages/inventory/freeze/index.tsx body, minus MainLayout chrome
// (supplied by the (dashboard) layout). Reads the shared /api/inventory/freeze*
// REST endpoints.

import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";

interface FreezeListItem {
  id: number;
  freezeDate: string;
  description: string | null;
  status: "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  totalItems: number;
  totalUnits: number;
  created: string;
  createdBy: string | null;
  _count: { items: number };
}

interface FreezeDetailGroup {
  storeLocation: { id: number; name: string; code: string } | null;
  items: Array<{
    id: number;
    productId: number;
    productName: string;
    productNumber: string;
    quantity: number;
  }>;
}

interface FreezeDetail {
  id: number;
  freezeDate: string;
  description: string | null;
  status: string;
  totalItems: number;
  totalUnits: number;
  groups: Record<string, FreezeDetailGroup>;
}

interface ComparisonDiff {
  productId: number;
  productName: string;
  productNumber: string;
  storeLocationCode: string | null;
  storeLocationName: string | null;
  quantity1: number;
  quantity2: number;
  difference: number;
}

interface ComparisonResult {
  freeze1: { id: number; freezeDate: string; description: string | null };
  freeze2: { id: number; freezeDate: string; description: string | null };
  differences: ComparisonDiff[];
  totalDifferences: number;
}

const STATUS_STYLES: Record<string, string> = {
  COMPLETED: "bg-green-100 text-green-800",
  IN_PROGRESS: "bg-yellow-100 text-yellow-800",
  CANCELLED: "bg-sh-gray/20 text-sh-gray",
};

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function diffColorClass(difference: number): string {
  if (difference > 0) return "text-green-700";
  if (difference < 0) return "text-red-700";
  return "text-sh-gray";
}

export function FreezeView() {
  const [freezes, setFreezes] = useState<FreezeListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<FreezeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Compare mode
  const [compareMode, setCompareMode] = useState(false);
  const [compareSelection, setCompareSelection] = useState<number[]>([]);
  const [comparison, setComparison] = useState<ComparisonResult | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);

  const loadFreezes = useCallback(async () => {
    try {
      const res = await axios.get<FreezeListItem[]>("/api/inventory/freeze");
      setFreezes(res.data);
    } catch {
      toast.error("Failed to load freezes.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFreezes();
  }, [loadFreezes]);

  const handleCreate = async () => {
    const description = globalThis.prompt("Optional description for this freeze:");
    if (description === null) return;

    setCreating(true);
    try {
      await axios.post("/api/inventory/freeze", {
        description: description || undefined,
      });
      toast.success("Inventory freeze created.");
      await loadFreezes();
    } catch {
      toast.error("Failed to create freeze.");
    } finally {
      setCreating(false);
    }
  };

  const handleCancel = async (id: number) => {
    if (!globalThis.confirm("Cancel this freeze? It will be marked as cancelled.")) return;
    try {
      await axios.delete(`/api/inventory/freeze/${id}`);
      toast.success("Freeze cancelled.");
      if (expandedId === id) {
        setExpandedId(null);
        setDetail(null);
      }
      await loadFreezes();
    } catch {
      toast.error("Failed to cancel freeze.");
    }
  };

  const handleExpand = async (id: number) => {
    if (expandedId === id) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(id);
    setDetailLoading(true);
    try {
      const res = await axios.get<FreezeDetail>(`/api/inventory/freeze/${id}`);
      setDetail(res.data);
    } catch {
      toast.error("Failed to load freeze details.");
      setExpandedId(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const toggleCompareSelection = (id: number) => {
    setCompareSelection((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [prev[1], id];
      return [...prev, id];
    });
  };

  const handleCompare = async () => {
    if (compareSelection.length !== 2) {
      toast.warn("Select exactly two freezes to compare.");
      return;
    }
    setCompareLoading(true);
    try {
      const res = await axios.get<ComparisonResult>("/api/inventory/freeze/compare", {
        params: { freezeId1: compareSelection[0], freezeId2: compareSelection[1] },
      });
      setComparison(res.data);
    } catch {
      toast.error("Failed to compare freezes.");
    } finally {
      setCompareLoading(false);
    }
  };

  const exitCompareMode = () => {
    setCompareMode(false);
    setCompareSelection([]);
    setComparison(null);
  };

  const completedFreezes = freezes.filter((f) => f.status === "COMPLETED");

  const handleRowActivate = (freeze: FreezeListItem) => {
    if (compareMode) {
      if (freeze.status === "COMPLETED") toggleCompareSelection(freeze.id);
    } else {
      handleExpand(freeze.id);
    }
  };

  return (
    <div className="py-2 space-y-6 font-serif">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-sh-blue">Inventory Freeze</h1>
          <p className="text-sh-gray text-sm mt-1">
            Point-in-time snapshots of current inventory positions.
          </p>
        </div>
        <div className="flex gap-2">
          {!compareMode && (
            <>
              <Button
                variant="outline"
                onClick={() => setCompareMode(true)}
                disabled={completedFreezes.length < 2}
              >
                Compare
              </Button>
              <Button onClick={handleCreate} disabled={creating}>
                {creating ? "Creating..." : "Create Freeze"}
              </Button>
            </>
          )}
          {compareMode && (
            <>
              <Button variant="outline" onClick={exitCompareMode}>
                Cancel
              </Button>
              <Button
                onClick={handleCompare}
                disabled={compareSelection.length !== 2 || compareLoading}
              >
                {compareLoading ? "Comparing..." : "Compare Selected"}
              </Button>
            </>
          )}
        </div>
      </div>

      {compareMode && !comparison && (
        <p className="text-sh-gray text-sm">
          Select two completed freezes to compare their inventory differences.
        </p>
      )}

      {comparison && <ComparisonView comparison={comparison} onClose={exitCompareMode} />}

      <FreezeList
        loading={loading}
        freezes={freezes}
        compareMode={compareMode}
        compareSelection={compareSelection}
        expandedId={expandedId}
        detail={detail}
        detailLoading={detailLoading}
        onToggleSelect={toggleCompareSelection}
        onActivate={handleRowActivate}
        onCancel={handleCancel}
      />
    </div>
  );
}

interface FreezeListProps {
  loading: boolean;
  freezes: FreezeListItem[];
  compareMode: boolean;
  compareSelection: number[];
  expandedId: number | null;
  detail: FreezeDetail | null;
  detailLoading: boolean;
  onToggleSelect: (id: number) => void;
  onActivate: (freeze: FreezeListItem) => void;
  onCancel: (id: number) => void;
}

function FreezeList({
  loading,
  freezes,
  compareMode,
  compareSelection,
  expandedId,
  detail,
  detailLoading,
  onToggleSelect,
  onActivate,
  onCancel,
}: Readonly<FreezeListProps>) {
  if (loading) {
    return <p className="text-sh-gray">Loading...</p>;
  }
  if (freezes.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-8 text-center">
        <p className="text-sh-gray">
          No freezes yet. Create one to snapshot the current inventory.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {freezes.map((freeze) => (
        <FreezeRow
          key={freeze.id}
          freeze={freeze}
          compareMode={compareMode}
          selected={compareSelection.includes(freeze.id)}
          expanded={expandedId === freeze.id}
          detail={detail}
          detailLoading={detailLoading}
          onToggleSelect={onToggleSelect}
          onActivate={onActivate}
          onCancel={onCancel}
        />
      ))}
    </div>
  );
}

interface FreezeRowProps {
  freeze: FreezeListItem;
  compareMode: boolean;
  selected: boolean;
  expanded: boolean;
  detail: FreezeDetail | null;
  detailLoading: boolean;
  onToggleSelect: (id: number) => void;
  onActivate: (freeze: FreezeListItem) => void;
  onCancel: (id: number) => void;
}

function FreezeRow({
  freeze,
  compareMode,
  selected,
  expanded,
  detail,
  detailLoading,
  onToggleSelect,
  onActivate,
  onCancel,
}: Readonly<FreezeRowProps>) {
  return (
    <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md">
      <div
        className="p-4 flex items-center justify-between cursor-pointer hover:bg-sh-stripe transition"
        role="button"
        tabIndex={0}
        onClick={() => onActivate(freeze)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          onActivate(freeze);
        }}
      >
        <div className="flex items-center gap-4">
          {compareMode && freeze.status === "COMPLETED" && (
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelect(freeze.id)}
              onClick={(e) => e.stopPropagation()}
              className="w-5 h-5 accent-sh-blue"
              aria-label={`Select freeze from ${formatDate(freeze.freezeDate)}`}
            />
          )}
          <div>
            <div className="flex items-center gap-3">
              <span className="font-semibold text-sh-black">{formatDate(freeze.freezeDate)}</span>
              <span
                className={`text-xs font-medium px-2 py-0.5 rounded ${STATUS_STYLES[freeze.status] || ""}`}
              >
                {freeze.status.replace("_", " ")}
              </span>
            </div>
            {freeze.description && (
              <p className="text-sh-gray text-sm mt-0.5">{freeze.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-6 text-sm text-sh-gray">
          <span>{freeze.totalItems.toLocaleString()} items</span>
          <span>{freeze.totalUnits.toLocaleString()} units</span>
          {!compareMode && freeze.status === "COMPLETED" && (
            <button
              type="button"
              className="text-red-600 hover:text-red-800 text-sm font-medium"
              onClick={(e) => {
                e.stopPropagation();
                onCancel(freeze.id);
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {expanded && !compareMode && (
        <div className="border-t border-sh-gray/10 p-4">
          <FreezeExpandedDetail loading={detailLoading} detail={detail} />
        </div>
      )}
    </div>
  );
}

function FreezeExpandedDetail({
  loading,
  detail,
}: Readonly<{ loading: boolean; detail: FreezeDetail | null }>) {
  if (loading) {
    return <p className="text-sh-gray text-sm">Loading details...</p>;
  }
  if (!detail) {
    return null;
  }
  return <FreezeDetailView detail={detail} />;
}

function FreezeDetailView({ detail }: Readonly<{ detail: FreezeDetail }>) {
  const groupKeys = Object.keys(detail.groups).sort((a, b) => a.localeCompare(b));

  if (groupKeys.length === 0) {
    return <p className="text-sh-gray text-sm">No items in this freeze.</p>;
  }

  return (
    <div className="space-y-4">
      {groupKeys.map((key) => {
        const group = detail.groups[key];
        const locationName = group.storeLocation?.name || "Unassigned";
        return (
          <div key={key}>
            <h3 className="text-sm font-semibold text-sh-blue mb-2">{locationName}</h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-sh-gray border-b border-sh-gray/10">
                  <th className="pb-1 font-medium">Product Number</th>
                  <th className="pb-1 font-medium">Name</th>
                  <th className="pb-1 font-medium text-right">Qty</th>
                </tr>
              </thead>
              <tbody>
                {group.items.map((item) => (
                  <tr
                    key={item.id}
                    className="border-b border-sh-gray/5 last:border-0 hover:bg-sh-stripe"
                  >
                    <td className="py-1.5 text-sh-black">{item.productNumber}</td>
                    <td className="py-1.5 text-sh-gray">{item.productName}</td>
                    <td className="py-1.5 text-right text-sh-black font-medium">{item.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

function ComparisonView({
  comparison,
  onClose,
}: Readonly<{ comparison: ComparisonResult; onClose: () => void }>) {
  return (
    <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-sh-blue">
          Comparison: {formatDate(comparison.freeze1.freezeDate)} vs{" "}
          {formatDate(comparison.freeze2.freezeDate)}
        </h2>
        <Button variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      <p className="text-sh-gray text-sm">
        {comparison.totalDifferences} difference{comparison.totalDifferences !== 1 ? "s" : ""}{" "}
        found.
      </p>
      {comparison.differences.length === 0 ? (
        <p className="text-sh-gray text-sm">No differences between these two freezes.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-sh-gray border-b border-sh-gray/10">
              <th className="pb-1 font-medium">Product</th>
              <th className="pb-1 font-medium">Location</th>
              <th className="pb-1 font-medium text-right">First</th>
              <th className="pb-1 font-medium text-right">Second</th>
              <th className="pb-1 font-medium text-right">Diff</th>
            </tr>
          </thead>
          <tbody>
            {comparison.differences.map((diff) => (
              <tr
                key={`${diff.productId}-${diff.storeLocationCode ?? "none"}`}
                className="border-b border-sh-gray/5 last:border-0 hover:bg-sh-stripe"
              >
                <td className="py-1.5">
                  <span className="text-sh-black">{diff.productNumber}</span>
                  <span className="text-sh-gray ml-2">{diff.productName}</span>
                </td>
                <td className="py-1.5 text-sh-gray">{diff.storeLocationName || "Unassigned"}</td>
                <td className="py-1.5 text-right text-sh-black">{diff.quantity1}</td>
                <td className="py-1.5 text-right text-sh-black">{diff.quantity2}</td>
                <td className={`py-1.5 text-right font-medium ${diffColorClass(diff.difference)}`}>
                  {diff.difference > 0 ? "+" : ""}
                  {diff.difference}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
