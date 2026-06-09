// /app/src/components/dashboard/OnHandByDepartment.tsx

import { useState, useEffect, useMemo } from "react";
import axios from "axios";
import { toast } from "react-toastify";

interface DepartmentTotal {
  department: string;
  totalQuantity: number;
  totalCost: number;
}

export default function OnHandByDepartment() {
  const [totals, setTotals] = useState<DepartmentTotal[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    axios
      .get<DepartmentTotal[]>("/api/inventory/onhand-by-department")
      .then((res) => setTotals(res.data))
      .catch(() => toast.error("Failed to load on-hand totals by department."))
      .finally(() => setLoading(false));
  }, []);

  const grandTotals = useMemo(() => {
    return totals.reduce(
      (acc, curr) => {
        acc.quantity += curr.totalQuantity;
        acc.cost += curr.totalCost;
        return acc;
      },
      { quantity: 0, cost: 0 },
    );
  }, [totals]);

  if (loading) {
    return <p>Loading on-hand summary...</p>;
  }

  return (
    <div>
      <h2 className="text-xl text-sh-blue mb-2">Snapshot On-Hand by Department</h2>
      <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
        <table className="min-w-full text-left text-sm whitespace-nowrap">
          <thead className="bg-sh-linen text-sh-black">
            <tr>
              <th className="p-2 border-b border-sh-gray">Department</th>
              <th className="p-2 border-b border-sh-gray text-right">Total On-Hand Quantity</th>
              <th className="p-2 border-b border-sh-gray text-right">Total On-Hand Cost</th>
            </tr>
          </thead>
          <tbody>
            {totals.map((item, i) => (
              <tr key={i} className="odd:bg-white even:bg-sh-stripe">
                <td className="p-2 border-b border-sh-gray">{item.department}</td>
                <td className="p-2 border-b border-sh-gray text-right font-bold">
                  {item.totalQuantity.toLocaleString()}
                </td>
                <td className="p-2 border-b border-sh-gray text-right font-bold">
                  {item.totalCost.toLocaleString("en-US", { style: "currency", currency: "USD" })}
                </td>
              </tr>
            ))}
            {totals.length === 0 && (
              <tr>
                <td colSpan={3} className="p-4 text-center text-sh-gray">
                  No snapshot data found. Please import a snapshot.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="bg-sh-blue text-white font-bold">
              <td className="p-2">Grand Total</td>
              <td className="p-2 text-right">{grandTotals.quantity.toLocaleString()}</td>
              <td className="p-2 text-right">
                {grandTotals.cost.toLocaleString("en-US", { style: "currency", currency: "USD" })}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {/* ADDED NOTE ABOUT COST ESTIMATION */}
      <p className="text-xs text-sh-gray mt-2 italic">
        Note: For items with a missing or zero cost, an estimated cost of 50% of the retail price is
        used for financial totals.
      </p>
    </div>
  );
}
