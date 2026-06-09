// /app/src/components/pricing/WoodPriceConfigurator.tsx
//
// Interactive configurator for wood furniture vendors (Gat Creek / Caperton).
// Tab flow: Product → Species [→ Size] → Options → Summary
// Products with speciesPrices use: Product → Species → Options → Summary
// Products with axisPrices use: Product → Species → Size → Options → Summary

import { useState, useMemo, useEffect } from "react";
import {
  WoodProductWithPricing,
  AvailableOption,
  calculateWoodPrice,
} from "@/lib/pricing/priceCalculator";
import StepTabs, { StepTabPanel, StepTabDefinition } from "@/components/ui/StepTabs";
import { Button } from "@/components/ui/button";
import {
  Search,
  Package,
  TreePine,
  Ruler,
  SlidersHorizontal,
  DollarSign,
  ChevronRight,
  ChevronLeft,
  AlertTriangle,
} from "lucide-react";

interface DimensionInfo {
  id: number;
  name: string;
  type: string;
  tiers: { id: number; code: string; name: string; sortOrder: number }[];
}

interface ConfiguredItemPayload {
  productId: number;
  productNumber: string;
  name: string;
  description: string;
  price: number;
  cost: number;
  vendor: string;
}

interface Props {
  products: WoodProductWithPricing[];
  dimensions: DimensionInfo[];
  vendorName: string;
  defaultMarkup: number;
  defaultDiscount: number;
  mapEnforced: boolean;
  retailOnly?: boolean;
  onAddToQuote?: (item: ConfiguredItemPayload) => void;
}

type TabId = "product" | "species" | "size" | "options" | "summary";

const TAB_ORDER: TabId[] = ["product", "species", "size", "options", "summary"];

export default function WoodPriceConfigurator({
  products,
  dimensions,
  vendorName,
  defaultMarkup,
  defaultDiscount,
  mapEnforced,
  retailOnly = false,
  onAddToQuote,
}: Props) {
  const [activeTab, setActiveTab] = useState<TabId>("product");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<WoodProductWithPricing | null>(null);
  const [selectedSpeciesTierId, setSelectedSpeciesTierId] = useState<number | null>(null);
  const [selectedWidthTierId, setSelectedWidthTierId] = useState<number | null>(null);
  const [selectedLengthTierId, setSelectedLengthTierId] = useState<number | null>(null);
  const [selectedOptions, setSelectedOptions] = useState<Set<number>>(new Set());
  const [discountPercent, setDiscountPercent] = useState(defaultDiscount);

  useEffect(() => {
    setDiscountPercent(defaultDiscount);
  }, [defaultDiscount]);

  // Identify dimension types
  const speciesDim = useMemo(() => dimensions.find((d) => d.type === "WOOD_SPECIES"), [dimensions]);
  const widthDim = useMemo(() => dimensions.find((d) => d.name === "Table Width"), [dimensions]);
  const lengthDim = useMemo(() => dimensions.find((d) => d.name === "Table Length"), [dimensions]);
  const diameterDim = useMemo(
    () => dimensions.find((d) => d.name === "Table Diameter"),
    [dimensions],
  );

  // Determine if selected product needs size selection
  const needsSizeSelection = useMemo(() => {
    if (!selectedProduct) return false;
    return selectedProduct.axisPrices.length > 0;
  }, [selectedProduct]);

  // Determine if it's a round table (diameter instead of width×length)
  const isRoundTable = useMemo(() => {
    if (!selectedProduct || selectedProduct.axisPrices.length === 0) return false;
    // Round tables use the N/A sentinel tier for tier3 (no length axis)
    return selectedProduct.axisPrices.every((ap) => ap.tier3?.code === "N_A");
  }, [selectedProduct]);

  // Get available sizes for the selected product + species
  const availableWidths = useMemo(() => {
    if (!selectedProduct || !needsSizeSelection) return [];
    const widthIds = new Set(selectedProduct.axisPrices.map((ap) => ap.tier2Id));
    if (isRoundTable && diameterDim) {
      return diameterDim.tiers.filter((t) => widthIds.has(t.id));
    }
    if (widthDim) {
      return widthDim.tiers.filter((t) => widthIds.has(t.id));
    }
    return [];
  }, [selectedProduct, needsSizeSelection, isRoundTable, widthDim, diameterDim]);

  const availableLengths = useMemo(() => {
    if (!selectedProduct || !needsSizeSelection || isRoundTable) return [];
    if (!selectedWidthTierId || !selectedSpeciesTierId) return [];
    // Filter lengths that exist for the selected species + width
    const lengthIds = new Set(
      selectedProduct.axisPrices
        .filter((ap) => ap.tier1Id === selectedSpeciesTierId && ap.tier2Id === selectedWidthTierId)
        .map((ap) => ap.tier3Id),
    );
    if (lengthDim) {
      // Filter out the N/A sentinel tier used for round products
      return lengthDim.tiers.filter((t) => lengthIds.has(t.id) && t.code !== "N_A");
    }
    return [];
  }, [
    selectedProduct,
    needsSizeSelection,
    isRoundTable,
    selectedSpeciesTierId,
    selectedWidthTierId,
    lengthDim,
  ]);

  // Filter products by search
  const filteredProducts = useMemo(() => {
    if (!searchQuery.trim()) return products;
    const q = searchQuery.toLowerCase();
    return products.filter(
      (p) =>
        p.productNumber.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        (p.description && p.description.toLowerCase().includes(q)),
    );
  }, [products, searchQuery]);

  // Calculate price when selections change
  const priceCalc = useMemo(() => {
    if (!selectedProduct || !selectedSpeciesTierId) return null;
    // For species products, we have enough. For axis products, need size too.
    if (needsSizeSelection) {
      if (isRoundTable && !selectedWidthTierId) return null;
      if (!isRoundTable && (!selectedWidthTierId || !selectedLengthTierId)) return null;
    }
    return calculateWoodPrice(
      selectedProduct,
      selectedSpeciesTierId,
      selectedOptions,
      defaultMarkup,
      discountPercent,
      mapEnforced,
      selectedWidthTierId ?? undefined,
      isRoundTable ? undefined : (selectedLengthTierId ?? undefined),
    );
  }, [
    selectedProduct,
    selectedSpeciesTierId,
    selectedWidthTierId,
    selectedLengthTierId,
    selectedOptions,
    defaultMarkup,
    discountPercent,
    mapEnforced,
    needsSizeSelection,
    isRoundTable,
  ]);

  const availableOpts = useMemo(
    () => selectedProduct?.availableOptions.filter((o) => o.isAvailable) ?? [],
    [selectedProduct],
  );

  // ─── Handlers ──────────────────────────────────────────────────

  const handleSelectProduct = (product: WoodProductWithPricing) => {
    setSelectedProduct(product);
    setSelectedSpeciesTierId(null);
    setSelectedWidthTierId(null);
    setSelectedLengthTierId(null);
    setSelectedOptions(new Set());
    setActiveTab("species");
  };

  const handleSelectSpecies = (tierId: number) => {
    setSelectedSpeciesTierId(tierId);
    setSelectedWidthTierId(null);
    setSelectedLengthTierId(null);
    if (needsSizeSelection) {
      setActiveTab("size");
    } else {
      const opts = selectedProduct?.availableOptions.filter((o) => o.isAvailable) ?? [];
      setActiveTab(opts.length > 0 ? "options" : "summary");
    }
  };

  const handleSelectSize = () => {
    // Called when size selection is complete
    const opts = selectedProduct?.availableOptions.filter((o) => o.isAvailable) ?? [];
    setActiveTab(opts.length > 0 ? "options" : "summary");
  };

  const toggleOption = (optionId: number) => {
    setSelectedOptions((prev) => {
      const next = new Set(prev);
      if (next.has(optionId)) next.delete(optionId);
      else next.add(optionId);
      return next;
    });
  };

  const handleDiscountChange = (val: string) => {
    const num = Number.parseFloat(val);
    if (Number.isNaN(num)) {
      setDiscountPercent(0);
    } else {
      setDiscountPercent(Math.max(0, Math.min(100, num)) / 100);
    }
  };

  const formatCurrency = (val: number) =>
    val.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

  // ─── Tab navigation ────────────────────────────────────────────

  const navigateTab = (direction: 1 | -1) => {
    const currentIndex = TAB_ORDER.indexOf(activeTab);
    let nextIndex = currentIndex + direction;

    // Skip size tab if product doesn't need it
    if (TAB_ORDER[nextIndex] === "size" && !needsSizeSelection) {
      nextIndex += direction;
    }
    // Skip options tab if no options
    if (TAB_ORDER[nextIndex] === "options" && availableOpts.length === 0) {
      nextIndex += direction;
    }

    if (nextIndex >= 0 && nextIndex < TAB_ORDER.length) {
      setActiveTab(TAB_ORDER[nextIndex]);
    }
  };

  const isNextDisabled = () => {
    if (activeTab === "summary") return true;
    if (activeTab === "product" && !selectedProduct) return true;
    if (activeTab === "species" && !selectedSpeciesTierId) return true;
    if (activeTab === "size") {
      if (isRoundTable && !selectedWidthTierId) return true;
      if (!isRoundTable && (!selectedWidthTierId || !selectedLengthTierId)) return true;
    }
    return false;
  };

  // ─── Tab definitions ──────────────────────────────────────────

  const tabs: StepTabDefinition[] = useMemo(() => {
    const selectedSpeciesName = speciesDim?.tiers.find((t) => t.id === selectedSpeciesTierId)?.name;

    const allTabs: StepTabDefinition[] = [
      {
        id: "product",
        label: "Product",
        icon: <Package className="w-4 h-4" />,
        subtitle: selectedProduct
          ? `${selectedProduct.productNumber} ${selectedProduct.name}`.substring(0, 40)
          : null,
        completed: !!selectedProduct,
      },
      {
        id: "species",
        label: "Species",
        icon: <TreePine className="w-4 h-4" />,
        subtitle: selectedSpeciesName || null,
        disabled: !selectedProduct,
        completed: !!selectedSpeciesTierId,
      },
      {
        id: "size",
        label: isRoundTable ? "Diameter" : "Size",
        icon: <Ruler className="w-4 h-4" />,
        subtitle: selectedWidthTierId
          ? isRoundTable
            ? availableWidths.find((t) => t.id === selectedWidthTierId)?.name || null
            : `${availableWidths.find((t) => t.id === selectedWidthTierId)?.name || "?"} × ${availableLengths.find((t) => t.id === selectedLengthTierId)?.name || "?"}`
          : null,
        disabled: !selectedSpeciesTierId || !needsSizeSelection,
        completed: needsSizeSelection
          ? isRoundTable
            ? !!selectedWidthTierId
            : !!selectedWidthTierId && !!selectedLengthTierId
          : true,
      },
      {
        id: "options",
        label: "Options",
        icon: <SlidersHorizontal className="w-4 h-4" />,
        subtitle: selectedOptions.size > 0 ? `${selectedOptions.size} selected` : null,
        disabled: !selectedSpeciesTierId,
        completed: availableOpts.length === 0 || selectedOptions.size > 0,
      },
      {
        id: "summary",
        label: "Summary",
        icon: <DollarSign className="w-4 h-4" />,
        subtitle: priceCalc ? formatCurrency(priceCalc.asShownPrice) : null,
        disabled: !selectedSpeciesTierId,
      },
    ];

    // Remove size tab if product doesn't need it
    if (!needsSizeSelection) {
      return allTabs.filter((t) => t.id !== "size");
    }

    return allTabs;
  }, [
    selectedProduct,
    selectedSpeciesTierId,
    selectedWidthTierId,
    selectedLengthTierId,
    selectedOptions,
    priceCalc,
    availableOpts.length,
    needsSizeSelection,
    isRoundTable,
    speciesDim,
    availableWidths,
    availableLengths,
  ]);

  // ─── Render ───────────────────────────────────────────────────

  return (
    <StepTabs
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={(id) => setActiveTab(id as TabId)}
      bottomBar={
        <div className="flex justify-between items-center">
          <Button
            variant="outline"
            onClick={() => navigateTab(-1)}
            disabled={activeTab === "product"}
            className="min-h-[44px]"
          >
            <ChevronLeft className="w-4 h-4 mr-1" /> Back
          </Button>
          <Button
            variant="primary"
            onClick={() => navigateTab(1)}
            disabled={isNextDisabled()}
            className="min-h-[44px]"
          >
            Next <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        </div>
      }
    >
      {/* ─── Product Tab ─────────────────────────────────────── */}
      <StepTabPanel tabId="product">
        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sh-gray" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by SKU or name..."
            className="w-full border border-sh-gray rounded-lg pl-10 pr-3 py-2 text-sh-black font-serif"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filteredProducts.slice(0, 100).map((p) => {
            const isSelected = selectedProduct?.id === p.id;
            const allPrices = [
              ...p.speciesPrices.map((sp) => sp.cost),
              ...p.axisPrices.map((ap) => ap.cost),
            ];
            const minPrice = allPrices.length > 0 ? Math.min(...allPrices) : p.baseCost || 0;
            const maxPrice = allPrices.length > 0 ? Math.max(...allPrices) : p.baseCost || 0;
            const priceLabel =
              p.speciesPrices.length > 0
                ? `${p.speciesPrices.length} species`
                : p.axisPrices.length > 0
                  ? "Custom sizes"
                  : "Flat price";

            return (
              <button
                key={p.id}
                onClick={() => handleSelectProduct(p)}
                className={`text-left rounded-lg border-2 p-4 transition-all ${
                  isSelected
                    ? "border-sh-blue bg-sh-linen shadow-md"
                    : "border-sh-gray/20 bg-white hover:border-sh-blue/40 hover:shadow-sm"
                }`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-semibold text-sh-black">{p.productNumber}</div>
                    <div className="text-sm text-sh-gray">{p.name}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-sh-gray">{priceLabel}</div>
                    <div className="text-sm font-semibold text-sh-blue tabular-nums">
                      {formatCurrency(minPrice)}
                      {maxPrice > minPrice && ` – ${formatCurrency(maxPrice)}`}
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
        {filteredProducts.length === 0 && (
          <div className="text-center py-8 text-sh-gray">No products match your search.</div>
        )}
        {filteredProducts.length > 100 && (
          <div className="text-center py-2 text-sm text-sh-gray">
            Showing 100 of {filteredProducts.length} — refine your search.
          </div>
        )}
      </StepTabPanel>

      {/* ─── Species Tab ─────────────────────────────────────── */}
      <StepTabPanel tabId="species">
        {selectedProduct && speciesDim && (
          <>
            <div className="flex items-center gap-2 mb-4">
              <Package className="w-5 h-5 text-sh-blue" />
              <span className="font-semibold text-sh-black">
                {selectedProduct.productNumber} — {selectedProduct.name}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {speciesDim.tiers.map((tier) => {
                // Find this species price for the selected product
                const speciesPrice = selectedProduct.speciesPrices.find(
                  (sp) => sp.tierId === tier.id,
                );
                // For axis products, find the min price for this species
                const axisMinPrice =
                  selectedProduct.axisPrices.length > 0
                    ? selectedProduct.axisPrices
                        .filter((ap) => ap.tier1Id === tier.id)
                        .reduce((min, ap) => Math.min(min, ap.cost), Infinity)
                    : null;

                const price =
                  speciesPrice?.cost ?? (axisMinPrice !== Infinity ? axisMinPrice : null);
                const isAvailable = price !== null;
                const isSelected = selectedSpeciesTierId === tier.id;

                return (
                  <button
                    key={tier.id}
                    onClick={() => isAvailable && handleSelectSpecies(tier.id)}
                    disabled={!isAvailable}
                    className={`rounded-lg border-2 p-4 text-left transition-all ${
                      isSelected
                        ? "border-sh-blue bg-sh-linen shadow-md"
                        : isAvailable
                          ? "border-sh-gray/20 bg-white hover:border-sh-blue/40 hover:shadow-sm"
                          : "border-sh-gray/10 bg-sh-gray/5 opacity-50 cursor-not-allowed"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <TreePine
                        className={`w-5 h-5 ${isSelected ? "text-sh-blue" : "text-sh-gray"}`}
                      />
                      <div>
                        <div className="font-semibold text-sh-black">{tier.name}</div>
                        {isAvailable && (
                          <div className="text-sm font-semibold text-sh-blue tabular-nums mt-1">
                            {selectedProduct.axisPrices.length > 0
                              ? `from ${formatCurrency(price!)}`
                              : formatCurrency(price!)}
                          </div>
                        )}
                        {!isAvailable && (
                          <div className="text-xs text-sh-gray mt-1">Not available</div>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </StepTabPanel>

      {/* ─── Size Tab (axis products only) ────────────────────── */}
      <StepTabPanel tabId="size">
        {selectedProduct && needsSizeSelection && selectedSpeciesTierId && (
          <>
            <div className="flex items-center gap-2 mb-4">
              <Ruler className="w-5 h-5 text-sh-blue" />
              <span className="font-semibold text-sh-black">
                Select {isRoundTable ? "Diameter" : "Size"}
              </span>
            </div>

            {isRoundTable ? (
              // Round table: simple diameter selection
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {availableWidths.map((tier) => {
                  const axisPrice = selectedProduct.axisPrices.find(
                    (ap) => ap.tier1Id === selectedSpeciesTierId && ap.tier2Id === tier.id,
                  );
                  const isSelected = selectedWidthTierId === tier.id;
                  return (
                    <button
                      key={tier.id}
                      onClick={() => {
                        setSelectedWidthTierId(tier.id);
                        handleSelectSize();
                      }}
                      className={`rounded-lg border-2 p-4 text-center transition-all ${
                        isSelected
                          ? "border-sh-blue bg-sh-linen shadow-md"
                          : "border-sh-gray/20 bg-white hover:border-sh-blue/40"
                      }`}
                    >
                      <div className="font-semibold text-sh-black">{tier.name}</div>
                      {axisPrice && (
                        <div className="text-sm font-semibold text-sh-blue tabular-nums mt-1">
                          {formatCurrency(axisPrice.cost)}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              // Rectangular table: width then length
              <div className="space-y-6">
                {/* Width selection */}
                <div>
                  <label className="text-sm font-semibold text-sh-gray mb-2 block">Width</label>
                  <div className="flex flex-wrap gap-2">
                    {availableWidths.map((tier) => {
                      const isSelected = selectedWidthTierId === tier.id;
                      return (
                        <button
                          key={tier.id}
                          onClick={() => {
                            setSelectedWidthTierId(tier.id);
                            setSelectedLengthTierId(null);
                          }}
                          className={`px-4 py-2 rounded-lg border-2 text-sm font-semibold transition-all ${
                            isSelected
                              ? "border-sh-blue bg-sh-linen text-sh-blue"
                              : "border-sh-gray/20 bg-white text-sh-black hover:border-sh-blue/40"
                          }`}
                        >
                          {tier.name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Length selection (shown after width selected) */}
                {selectedWidthTierId && availableLengths.length > 0 && (
                  <div>
                    <label className="text-sm font-semibold text-sh-gray mb-2 block">Length</label>
                    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
                      {availableLengths.map((tier) => {
                        const axisPrice = selectedProduct.axisPrices.find(
                          (ap) =>
                            ap.tier1Id === selectedSpeciesTierId &&
                            ap.tier2Id === selectedWidthTierId &&
                            ap.tier3Id === tier.id,
                        );
                        const isSelected = selectedLengthTierId === tier.id;
                        return (
                          <button
                            key={tier.id}
                            onClick={() => {
                              setSelectedLengthTierId(tier.id);
                              handleSelectSize();
                            }}
                            className={`rounded-lg border-2 p-3 text-center transition-all ${
                              isSelected
                                ? "border-sh-blue bg-sh-linen shadow-md"
                                : "border-sh-gray/20 bg-white hover:border-sh-blue/40"
                            }`}
                          >
                            <div className="font-semibold text-sh-black text-sm">{tier.name}</div>
                            {axisPrice && (
                              <div className="text-xs font-semibold text-sh-blue tabular-nums mt-1">
                                {formatCurrency(axisPrice.cost)}
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </StepTabPanel>

      {/* ─── Options Tab ─────────────────────────────────────── */}
      <StepTabPanel tabId="options">
        {availableOpts.length > 0 ? (
          <div className="bg-white rounded-lg border border-sh-gray/20 shadow-sm divide-y divide-sh-gray/10">
            {availableOpts.map((option) => (
              <label
                key={option.optionId}
                className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-sh-linen/50 transition"
              >
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={option.isStandard || selectedOptions.has(option.optionId)}
                    disabled={option.isStandard}
                    onChange={() => toggleOption(option.optionId)}
                    className="w-5 h-5 accent-sh-blue"
                  />
                  <div>
                    <div className="text-sm text-sh-black">{option.optionName}</div>
                    <div className="text-xs text-sh-gray">{option.groupName}</div>
                  </div>
                </div>
                <div className="text-sm font-semibold tabular-nums text-sh-black">
                  {option.isStandard
                    ? "Included"
                    : option.surcharge > 0
                      ? `+${formatCurrency(option.surcharge)}`
                      : "No charge"}
                </div>
              </label>
            ))}
          </div>
        ) : (
          <div className="text-center py-12 text-sh-gray">
            <SlidersHorizontal className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No options available for this product.</p>
            <Button
              variant="primary"
              className="mt-4 min-h-[44px]"
              onClick={() => setActiveTab("summary")}
            >
              Continue to Summary <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </div>
        )}
      </StepTabPanel>

      {/* ─── Summary Tab ─────────────────────────────────────── */}
      <StepTabPanel tabId="summary">
        {priceCalc && selectedProduct ? (
          <div className="w-full max-w-2xl mx-auto space-y-4">
            <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
              {!retailOnly && (
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-sh-black">Base Cost ({priceCalc.gradeName})</span>
                    <span className="font-semibold tabular-nums">
                      {formatCurrency(priceCalc.basePrice)}
                    </span>
                  </div>
                  {priceCalc.optionLines.map((line, i) => (
                    <div key={i} className="flex justify-between text-sm">
                      <span className="text-sh-gray flex items-center gap-1">
                        <ChevronRight className="w-3 h-3" />
                        {line.label}
                      </span>
                      <span className="tabular-nums">+{formatCurrency(line.amount)}</span>
                    </div>
                  ))}
                </div>
              )}

              {!retailOnly && <div className="border-t border-sh-gray/20 my-4" />}

              {!retailOnly && (
                <div className="flex justify-between text-base font-semibold">
                  <span className="text-sh-blue">Total Wholesale</span>
                  <span className="text-sh-black tabular-nums">
                    {formatCurrency(priceCalc.totalCost)}
                  </span>
                </div>
              )}

              <div className="flex justify-between text-sm mt-2">
                <span className="text-sh-gray">
                  {retailOnly ? "Retail Price" : `Suggested Retail (${defaultMarkup}x)`}
                </span>
                <span className="font-semibold text-sh-black tabular-nums">
                  {formatCurrency(priceCalc.suggestedRetail)}
                </span>
              </div>

              <div className="flex justify-between items-center text-sm mt-2">
                <span className="text-sh-gray flex items-center gap-2">
                  Discount
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    max="100"
                    step="1"
                    value={Math.round(discountPercent * 100)}
                    onChange={(e) => handleDiscountChange(e.target.value)}
                    className="w-14 border border-sh-gray rounded px-2 py-0.5 text-center text-sh-black tabular-nums text-sm"
                  />
                  <span>%</span>
                </span>
                <span className="tabular-nums text-red-600">
                  {priceCalc.discountAmount > 0
                    ? `−${formatCurrency(priceCalc.discountAmount)}`
                    : "\u2014"}
                </span>
              </div>

              <div className="border-t border-sh-gray/20 my-4" />

              <div className="flex justify-between text-lg font-semibold">
                <span className="text-sh-blue">As-Shown Price</span>
                <span className="text-sh-gold tabular-nums">
                  {formatCurrency(priceCalc.asShownPrice)}
                </span>
              </div>

              {priceCalc.mapWarning && (
                <div className="flex items-center gap-2 mt-2 bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2">
                  <AlertTriangle className="w-4 h-4 text-yellow-600 flex-shrink-0" />
                  <span className="text-xs text-yellow-700">
                    Below MAP ({formatCurrency(priceCalc.mapPrice!)}). Minimum advertised price is
                    enforced.
                  </span>
                </div>
              )}

              {!retailOnly && (
                <div className="flex justify-between text-sm mt-3">
                  <span className="text-sh-gray">Margin</span>
                  <span
                    className={`font-semibold tabular-nums ${priceCalc.margin >= 0 ? "text-green-700" : "text-red-600"}`}
                  >
                    {formatCurrency(priceCalc.margin)} ({(priceCalc.marginPercent * 100).toFixed(1)}
                    %)
                  </span>
                </div>
              )}
            </div>

            {/* Add to Quote button (visible when navigated from quote builder) */}
            {onAddToQuote && (
              <button
                onClick={() => {
                  const descParts: string[] = [priceCalc.gradeName];
                  const activeOpts = availableOpts.filter(
                    (o) => o.isStandard || selectedOptions.has(o.optionId),
                  );
                  for (const opt of activeOpts) descParts.push(opt.optionName);
                  onAddToQuote({
                    productId: selectedProduct.id,
                    productNumber: selectedProduct.productNumber,
                    name: selectedProduct.name || selectedProduct.productNumber,
                    description: descParts.join(", "),
                    price: priceCalc.suggestedRetail,
                    cost: priceCalc.totalCost,
                    vendor: vendorName,
                  });
                }}
                className="w-full py-3 rounded-lg bg-sh-gold text-white font-semibold text-base transition hover:bg-sh-gold/90 min-h-[44px]"
              >
                Add to Quote
              </button>
            )}
          </div>
        ) : (
          <div className="text-center py-12 text-sh-gray">
            <DollarSign className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Select a product and species to see the price summary.</p>
          </div>
        )}
      </StepTabPanel>
    </StepTabs>
  );
}
