// /app/src/components/sales/DenominationCountTable.tsx
//
// Shared denomination count table used by both the open-till and close-till
// flows on /sales/till. Given a list of denominations and the current qty
// state, renders a table with an input per row and a running total. Parent
// owns the state; this component only renders and emits change events.

import { useMemo } from "react";

export interface DenominationDef {
  label: string;
  value: number;
}

export const DENOMINATIONS: DenominationDef[] = [
  { label: "$100", value: 100 },
  { label: "$50", value: 50 },
  { label: "$20", value: 20 },
  { label: "$10", value: 10 },
  { label: "$5", value: 5 },
  { label: "$1", value: 1 },
  { label: "Quarters", value: 0.25 },
  { label: "Dimes", value: 0.1 },
  { label: "Nickels", value: 0.05 },
  { label: "Pennies", value: 0.01 },
];

export interface DenominationCountEntry {
  denomination: string;
  quantity: number;
  amount: number;
}

interface Props {
  counts: Record<string, number>;
  onChange: (next: Record<string, number>) => void;
  totalLabel?: string;
}

const fmt = (n: number) => `$${n.toFixed(2)}`;

export function calcTotal(counts: Record<string, number>): number {
  let total = 0;
  for (const d of DENOMINATIONS) {
    total += (counts[d.label] || 0) * d.value;
  }
  return Math.round(total * 100) / 100;
}

export function toCountEntries(counts: Record<string, number>): DenominationCountEntry[] {
  return DENOMINATIONS.map((d) => ({
    denomination: d.label,
    quantity: counts[d.label] || 0,
    amount: Math.round((counts[d.label] || 0) * d.value * 100) / 100,
  }));
}

export default function DenominationCountTable({
  counts,
  onChange,
  totalLabel = "Actual Cash Total",
}: Props) {
  const total = useMemo(() => calcTotal(counts), [counts]);

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-sh-gray border-b border-sh-gray/10">
          <th className="py-2 pr-4 font-medium">Denomination</th>
          <th className="py-2 pr-4 font-medium w-28">Quantity</th>
          <th className="py-2 font-medium w-28 text-right">Amount</th>
        </tr>
      </thead>
      <tbody>
        {DENOMINATIONS.map((d) => {
          const qty = counts[d.label] || 0;
          const amount = Math.round(qty * d.value * 100) / 100;
          return (
            <tr key={d.label} className="border-b border-sh-gray/5">
              <td className="py-2 pr-4 text-sh-black">{d.label}</td>
              <td className="py-2 pr-4">
                <input
                  type="number"
                  min="0"
                  value={qty || ""}
                  onChange={(e) =>
                    onChange({ ...counts, [d.label]: Number.parseInt(e.target.value) || 0 })
                  }
                  className="w-full border border-sh-gray/30 rounded px-2 py-1 text-sm text-right"
                />
              </td>
              <td className="py-2 text-right text-sh-black">{fmt(amount)}</td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-sh-gray/20">
          <td className="py-3 font-semibold text-sh-black" colSpan={2}>
            {totalLabel}
          </td>
          <td className="py-3 text-right font-semibold text-sh-black">{fmt(total)}</td>
        </tr>
      </tfoot>
    </table>
  );
}
