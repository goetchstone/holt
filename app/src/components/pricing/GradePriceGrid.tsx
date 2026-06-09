// /app/src/components/pricing/GradePriceGrid.tsx
//
// Visual grid of clickable grade price cells for the product configurator.
// Extrapolated grades (computed from the grade riser) are shown with a
// dashed border and "(est.)" label to distinguish them from published prices.
// When `markup` is provided, displays retail prices (cost * markup).

import { GradePrice } from "@/lib/pricing/priceCalculator";

interface Props {
  gradePrices: GradePrice[];
  selectedTierId: number | null;
  onSelect: (tierId: number) => void;
  markup?: number;
}

export default function GradePriceGrid({ gradePrices, selectedTierId, onSelect, markup }: Props) {
  if (gradePrices.length === 0) {
    return <div className="text-sh-gray text-sm">No grade pricing available.</div>;
  }

  const formatPrice = (val: number) =>
    val.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });

  return (
    <div className="grid grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
      {gradePrices.map((gp) => {
        const isSelected = gp.tierId === selectedTierId;
        const isExtrapolated = gp.extrapolated === true;
        const displayPrice = markup ? gp.cost * markup : gp.cost;

        return (
          <button
            key={gp.tierId}
            onClick={() => onSelect(gp.tierId)}
            className={`rounded-lg px-2 py-3 text-center transition-all ${
              isSelected
                ? "border-2 border-sh-blue bg-sh-linen shadow-md scale-105"
                : isExtrapolated
                  ? "border-2 border-dashed border-sh-gray/30 bg-white hover:border-sh-blue/40 hover:shadow-sm"
                  : "border-2 border-sh-gray/20 bg-white hover:border-sh-blue/40 hover:shadow-sm"
            }`}
          >
            <div
              className={`text-xs font-semibold mb-1 ${
                isSelected ? "text-sh-blue" : "text-sh-gray"
              }`}
            >
              {gp.tierCode === "COM" ? "COM" : `Grade ${gp.tierCode}`}
            </div>
            <div
              className={`text-sm font-semibold tabular-nums ${
                isSelected
                  ? "text-sh-black"
                  : isExtrapolated
                    ? "text-sh-black/50"
                    : "text-sh-black/70"
              }`}
            >
              {formatPrice(displayPrice)}
            </div>
            {isExtrapolated && <div className="text-[10px] text-sh-gray/60 mt-0.5">(est.)</div>}
            {(gp.fabricCount ?? 0) > 0 && (
              <div className="text-[10px] text-sh-blue/60 mt-0.5">
                {gp.fabricCount} fabric{gp.fabricCount !== 1 ? "s" : ""}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
