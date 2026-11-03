"use client";

// GAP-07: who a sale is split with, and the seller's share of it, on the
// register and the quote builder. Shown only to someone allowed to split a
// sale ("Reassign salesperson"); the page passes the colleagues and the store's
// default share (lib/sales/splitSaleSetup.ts). The partner is credited the
// rest (lib/commissionSplit.ts); create-from-cart checks it all again.

import {
  EVEN_SPLIT_PERCENT,
  SPLIT_PERCENT_MAX,
  SPLIT_PERCENT_MIN,
  type SplitSaleSetup,
  isSplitPercent,
} from "@/lib/commissionSplit";

export interface SplitChoice {
  splitWithId: number | null;
  splitPercent: number;
}

export function emptySplit(setup: SplitSaleSetup | null): SplitChoice {
  return { splitWithId: null, splitPercent: setup?.defaultPercent ?? EVEN_SPLIT_PERCENT };
}

/** The create-from-cart body fields for a choice: none unless it is split. */
export function splitBody(choice: SplitChoice): { splitWithId?: number; splitPercent?: number } {
  return choice.splitWithId == null
    ? {}
    : { splitWithId: choice.splitWithId, splitPercent: choice.splitPercent };
}

export function SplitSaleField({
  setup,
  value,
  onChange,
}: Readonly<{
  setup: SplitSaleSetup | null;
  value: SplitChoice;
  onChange: (choice: SplitChoice) => void;
}>) {
  if (!setup || setup.partners.length === 0) return null;
  const partner = setup.partners.find((p) => p.id === value.splitWithId);
  return (
    <div className="flex flex-wrap items-end gap-2 text-sm">
      <div>
        <label htmlFor="split-with" className="mb-1 block text-xs text-brand-gray">
          Split the sale with
        </label>
        <select
          id="split-with"
          value={value.splitWithId ?? ""}
          onChange={(e) =>
            onChange({
              ...value,
              splitWithId: e.target.value ? Number(e.target.value) : null,
            })
          }
          className="rounded border border-brand-gray/30 bg-white px-2 py-1"
        >
          <option value="">Not split</option>
          {setup.partners.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {partner && (
        <div>
          <label htmlFor="split-share" className="mb-1 block text-xs text-brand-gray">
            Your share (%)
          </label>
          <input
            id="split-share"
            type="number"
            min={SPLIT_PERCENT_MIN}
            max={SPLIT_PERCENT_MAX}
            step={1}
            value={value.splitPercent}
            onChange={(e) =>
              onChange({ ...value, splitPercent: Math.round(Number(e.target.value) || 0) })
            }
            className="w-20 rounded border border-brand-gray/30 px-2 py-1"
          />
        </div>
      )}
      {partner && (
        <p className="pb-1 text-xs text-brand-gray">
          {isSplitPercent(value.splitPercent)
            ? `${partner.name} is credited ${100 - value.splitPercent}%.`
            : `A share is ${SPLIT_PERCENT_MIN} to ${SPLIT_PERCENT_MAX}%.`}
        </p>
      )}
    </div>
  );
}
