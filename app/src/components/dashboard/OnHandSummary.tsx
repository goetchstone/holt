// /app/src/components/dashboard/OnHandSummary.tsx

import { useState, useEffect, useMemo, useCallback } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ArrowUpDown } from "lucide-react";
import Link from "next/link";
import { CostHiddenNote } from "@/components/ui/CostHiddenNote";

interface SummaryTotal {
  department?: string;
  location?: string;
  expectedQty: number;
  countedQty: number;
  varianceQty: number;
  // Present only for a viewer holding "View cost" (the response says which).
  expectedCost?: number;
  countedCost?: number;
  varianceCost?: number;
}

interface SummaryResponse {
  rows: SummaryTotal[];
  costVisible: boolean;
}

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

type SortConfig = {
  key: keyof SummaryTotal;
  direction: "asc" | "desc";
} | null;

export default function OnHandSummary() {
  const [departmentTotals, setDepartmentTotals] = useState<SummaryTotal[]>([]);
  const [locationTotals, setLocationTotals] = useState<SummaryTotal[]>([]);
  // null until a response says: a failed load must not claim cost is hidden
  // for a role that holds it.
  const [showCost, setShowCost] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const [deptRes, locRes] = await Promise.all([
          axios.get<SummaryResponse>("/api/inventory/onhand-by-department"),
          axios.get<SummaryResponse>("/api/inventory/onhand-by-location"),
        ]);
        setDepartmentTotals(deptRes.data.rows);
        setLocationTotals(locRes.data.rows);
        setShowCost(deptRes.data.costVisible && locRes.data.costVisible);
      } catch (error) {
        toast.error("Failed to load on-hand summary data.");
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  if (loading) {
    return <p>Loading on-hand summary...</p>;
  }

  return (
    <div>
      <h2 className="text-xl text-brand-blue mb-2">Snapshot vs. Physical Count Summary</h2>
      <Tabs defaultValue="department">
        <TabsList>
          <TabsTrigger value="department">By Department</TabsTrigger>
          <TabsTrigger value="location">By Location</TabsTrigger>
        </TabsList>
        <TabsContent tabValue="department">
          <SortableSummaryTable
            data={departmentTotals}
            groupKey="department"
            showCost={showCost === true}
          />
        </TabsContent>
        <TabsContent tabValue="location">
          <SortableSummaryTable
            data={locationTotals}
            groupKey="location"
            showCost={showCost === true}
          />
        </TabsContent>
      </Tabs>
      {showCost === true && (
        <p className="text-xs text-brand-gray mt-2 italic">
          Note: For items with a missing or zero cost, an estimated cost of 50% of the retail price
          is used for financial totals.
        </p>
      )}
      {showCost === false && <CostHiddenNote className="mt-2" />}
    </div>
  );
}

// New Sortable Table Component with Totals Footer
const SortableSummaryTable = ({
  data,
  groupKey,
  showCost,
}: {
  data: SummaryTotal[];
  groupKey: "department" | "location";
  showCost: boolean;
}) => {
  const [sortConfig, setSortConfig] = useState<SortConfig>({
    key: showCost ? "varianceCost" : "varianceQty",
    direction: "asc",
  });

  const sortedData = useMemo(() => {
    const sortableItems = [...data];
    if (sortConfig !== null) {
      sortableItems.sort((a, b) => {
        const aValue = a[sortConfig.key] ?? 0;
        const bValue = b[sortConfig.key] ?? 0;

        if (aValue < bValue) {
          return sortConfig.direction === "asc" ? -1 : 1;
        }
        if (aValue > bValue) {
          return sortConfig.direction === "asc" ? 1 : -1;
        }
        return 0;
      });
    }
    return sortableItems;
  }, [data, sortConfig]);

  const requestSort = (key: keyof SummaryTotal) => {
    let direction: "asc" | "desc" = "asc";
    if (sortConfig && sortConfig.key === key && sortConfig.direction === "asc") {
      direction = "desc";
    }
    setSortConfig({ key, direction });
  };

  const grandTotals = useMemo(() => {
    return data.reduce<Required<Omit<SummaryTotal, "department" | "location">>>(
      (acc, curr) => {
        acc.expectedQty += curr.expectedQty;
        acc.countedQty += curr.countedQty;
        acc.varianceQty += curr.varianceQty;
        acc.expectedCost += curr.expectedCost ?? 0;
        acc.countedCost += curr.countedCost ?? 0;
        acc.varianceCost += curr.varianceCost ?? 0;
        return acc;
      },
      {
        expectedQty: 0,
        countedQty: 0,
        varianceQty: 0,
        expectedCost: 0,
        countedCost: 0,
        varianceCost: 0,
      },
    );
  }, [data]);

  const headers: { key: keyof SummaryTotal; label: string; isNumeric?: boolean }[] = [
    { key: groupKey, label: groupKey.charAt(0).toUpperCase() + groupKey.slice(1) },
    { key: "expectedQty", label: "Expected Qty", isNumeric: true },
    { key: "countedQty", label: "Counted Qty", isNumeric: true },
    { key: "varianceQty", label: "Variance Qty", isNumeric: true },
    ...(showCost
      ? [
          { key: "expectedCost" as const, label: "Expected Cost", isNumeric: true },
          { key: "countedCost" as const, label: "Counted Cost", isNumeric: true },
          { key: "varianceCost" as const, label: "Variance Cost", isNumeric: true },
        ]
      : []),
  ];

  const getVarianceClass = (value: number) => {
    if (value < -0.01) return "text-red-600";
    if (value > 0.01) return "text-green-600";
    return "";
  };

  return (
    <div className="border border-brand-gray rounded-lg overflow-hidden shadow-sm">
      <table className="min-w-full text-left text-sm whitespace-nowrap">
        <thead className="bg-brand-linen text-brand-black">
          <tr>
            {headers.map(({ key, label, isNumeric }) => (
              <th
                key={key}
                className={`p-2 border-b border-brand-gray ${isNumeric ? "text-right" : ""}`}
              >
                <button onClick={() => requestSort(key)} className="flex items-center gap-1">
                  {label} <ArrowUpDown className="w-3 h-3 text-gray-400" />
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedData.map((item, i) => (
            <tr key={i} className="odd:bg-white even:bg-brand-stripe">
              <td className="p-2 border-b border-brand-gray font-semibold">
                <Link
                  href={`/app/inventory/summary-details?groupType=${groupKey}&groupName=${encodeURIComponent(item[groupKey] || "")}`}
                  className="text-brand-blue hover:underline"
                >
                  {item[groupKey]}
                </Link>
              </td>
              <td className="p-2 border-b border-brand-gray text-right">
                {item.expectedQty.toLocaleString()}
              </td>
              <td className="p-2 border-b border-brand-gray text-right">
                {item.countedQty.toLocaleString()}
              </td>
              <td
                className={`p-2 border-b border-brand-gray text-right font-bold ${getVarianceClass(item.varianceQty)}`}
              >
                {item.varianceQty.toLocaleString()}
              </td>
              {showCost && (
                <>
                  <td className="p-2 border-b border-brand-gray text-right">
                    {usd(item.expectedCost ?? 0)}
                  </td>
                  <td className="p-2 border-b border-brand-gray text-right">
                    {usd(item.countedCost ?? 0)}
                  </td>
                  <td
                    className={`p-2 border-b border-brand-gray text-right font-bold ${getVarianceClass(item.varianceCost ?? 0)}`}
                  >
                    {usd(item.varianceCost ?? 0)}
                  </td>
                </>
              )}
            </tr>
          ))}
          {data.length === 0 && (
            <tr>
              <td colSpan={headers.length} className="p-4 text-center text-brand-gray">
                No data found.
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr className="bg-brand-blue text-white font-bold">
            <td className="p-2">Grand Total</td>
            <td className="p-2 text-right">{grandTotals.expectedQty.toLocaleString()}</td>
            <td className="p-2 text-right">{grandTotals.countedQty.toLocaleString()}</td>
            <td className={`p-2 text-right ${getVarianceClass(grandTotals.varianceQty)}`}>
              {grandTotals.varianceQty.toLocaleString()}
            </td>
            {showCost && (
              <>
                <td className="p-2 text-right">{usd(grandTotals.expectedCost)}</td>
                <td className="p-2 text-right">{usd(grandTotals.countedCost)}</td>
                <td className={`p-2 text-right ${getVarianceClass(grandTotals.varianceCost)}`}>
                  {usd(grandTotals.varianceCost)}
                </td>
              </>
            )}
          </tr>
        </tfoot>
      </table>
    </div>
  );
};
