// /app/src/components/pricing/PriceConfigurator.tsx
//
// Interactive product configurator with tabbed UI.
// Tab flow: Product → Grade → Options → Summary
// Auto-advances on selection, iPad-friendly touch targets.

import { useState, useMemo, useEffect, useCallback } from "react";
import { ProductWithPricing, calculatePrice } from "@/lib/pricing/priceCalculator";
import GradePriceGrid from "./GradePriceGrid";
import StepTabs, { StepTabPanel, StepTabDefinition } from "@/components/ui/StepTabs";
import { Button } from "@/components/ui/button";
import {
  Search,
  Package,
  Layers,
  SlidersHorizontal,
  DollarSign,
  ChevronRight,
  ChevronLeft,
  AlertTriangle,
  Palette,
} from "lucide-react";
import axios from "axios";
import ProductEntryPanel from "./ProductEntryPanel";
import { buildProductEntryData } from "@/lib/pricing/productEntryMapping";

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
  products: ProductWithPricing[];
  vendorId: number;
  vendorName: string;
  defaultMarkup: number;
  defaultDiscount: number;
  mapEnforced: boolean;
  retailOnly?: boolean;
  onAddToQuote?: (item: ConfiguredItemPayload) => void;
}

type TabId = "product" | "grade" | "fabric" | "options" | "summary";

const TAB_ORDER: TabId[] = ["product", "grade", "fabric", "options", "summary"];

export default function PriceConfigurator({
  products,
  vendorId,
  vendorName,
  defaultMarkup,
  defaultDiscount,
  mapEnforced,
  retailOnly = false,
  onAddToQuote,
}: Props) {
  const [activeTab, setActiveTab] = useState<TabId>("product");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<ProductWithPricing | null>(null);
  const [selectedTierId, setSelectedTierId] = useState<number | null>(null);
  const [selectedOptions, setSelectedOptions] = useState<Set<number>>(new Set());
  const [selectedFinishId, setSelectedFinishId] = useState<number | null>(null);
  const [optionTextValues, setOptionTextValues] = useState<Record<number, string>>({});
  const [discountPercent, setDiscountPercent] = useState(defaultDiscount);

  // Fabric state
  const [fabricSearch, setFabricSearch] = useState("");
  const [fabrics, setFabrics] = useState<any[]>([]);
  const [fabricsLoading, setFabricsLoading] = useState(false);
  const [fabricTierLoaded, setFabricTierLoaded] = useState<number | null>(null);
  const [selectedFabric, setSelectedFabric] = useState<any | null>(null);

  // Sync discount when vendor changes
  useEffect(() => {
    setDiscountPercent(defaultDiscount);
  }, [defaultDiscount]);

  // Load fabrics for the selected grade when the browser is opened
  const loadFabrics = useCallback(
    async (tierId: number) => {
      if (fabricTierLoaded === tierId && fabrics.length > 0) return; // already loaded
      setFabricsLoading(true);
      try {
        const res = await axios.get("/api/pricing/fabrics", {
          params: { vendorId, tierId },
        });
        setFabrics(res.data.fabrics || []);
        setFabricTierLoaded(tierId);
      } catch {
        setFabrics([]);
      } finally {
        setFabricsLoading(false);
      }
    },
    [vendorId, fabricTierLoaded, fabrics.length],
  );

  // Load fabrics when the fabric tab is active and we have a selected tier
  useEffect(() => {
    if (activeTab === "fabric" && selectedTierId) {
      loadFabrics(selectedTierId);
    }
  }, [activeTab, selectedTierId, loadFabrics]);

  // Reset fabric state when product changes
  useEffect(() => {
    setFabrics([]);
    setFabricTierLoaded(null);
    setSelectedFabric(null);
    setFabricSearch("");
  }, [selectedProduct]);

  // Reset fabric list when grade changes (but keep browser open)
  useEffect(() => {
    if (selectedTierId !== fabricTierLoaded) {
      setFabrics([]);
      setFabricTierLoaded(null);
      setSelectedFabric(null);
      setFabricSearch("");
    }
  }, [selectedTierId]);

  // Filter fabrics by search
  const filteredFabrics = useMemo(() => {
    if (!fabricSearch.trim()) return fabrics;
    const q = fabricSearch.toLowerCase();
    return fabrics.filter(
      (f: any) =>
        f.fabricName.toLowerCase().includes(q) ||
        (f.colorName && f.colorName.toLowerCase().includes(q)),
    );
  }, [fabrics, fabricSearch]);

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

  // Merge finish selection with checkbox selections for price calculation
  const allSelectedOptions = useMemo(() => {
    const combined = new Set(selectedOptions);
    if (selectedFinishId != null) combined.add(selectedFinishId);
    return combined;
  }, [selectedOptions, selectedFinishId]);

  // Calculate price when selections change
  const priceCalc = useMemo(() => {
    if (!selectedProduct || !selectedTierId) return null;
    return calculatePrice(
      selectedProduct,
      selectedTierId,
      allSelectedOptions,
      defaultMarkup,
      discountPercent,
      mapEnforced,
    );
  }, [
    selectedProduct,
    selectedTierId,
    allSelectedOptions,
    defaultMarkup,
    discountPercent,
    mapEnforced,
  ]);

  // Selected grade tier code (for conditional COM yardage display)
  const selectedGradeTierCode = useMemo(() => {
    if (!selectedProduct || !selectedTierId) return null;
    return selectedProduct.gradePrices.find((g) => g.tierId === selectedTierId)?.tierCode ?? null;
  }, [selectedProduct, selectedTierId]);

  // Filter grades: hide grades with no fabrics when the vendor has a fabric catalog.
  // Always keep COM and the currently selected grade visible.
  const vendorHasFabrics = selectedProduct?.gradePrices.some((gp) => (gp.fabricCount ?? 0) > 0);
  const visibleGrades = useMemo(() => {
    if (!selectedProduct) return [];
    if (!vendorHasFabrics) return selectedProduct.gradePrices;
    return selectedProduct.gradePrices.filter(
      (gp) => (gp.fabricCount ?? 0) > 0 || gp.tierCode === "COM" || gp.tierId === selectedTierId,
    );
  }, [selectedProduct, vendorHasFabrics, selectedTierId]);

  // Available options for the selected product, split into finish dropdown vs checkboxes
  const availableOpts = useMemo(
    () => selectedProduct?.availableOptions.filter((o) => o.isAvailable) ?? [],
    [selectedProduct],
  );
  const finishOpts = useMemo(
    () => availableOpts.filter((o) => o.groupName === "Wood Finish"),
    [availableOpts],
  );
  const otherOpts = useMemo(
    () => availableOpts.filter((o) => o.groupName !== "Wood Finish"),
    [availableOpts],
  );

  // Build the POS entry data when in retail mode with a fully configured product
  const productEntryData = useMemo(() => {
    if (!retailOnly || !selectedProduct || !priceCalc) return null;
    const selectedFinishOpt = finishOpts.find((o) => o.optionId === selectedFinishId);
    const activeOptionNames = otherOpts
      .filter((o) => o.isStandard || selectedOptions.has(o.optionId))
      .map((o) => o.optionName);
    return buildProductEntryData({
      vendorName,
      collection: selectedProduct.collection,
      product: selectedProduct,
      gradeName: priceCalc.gradeName,
      fabricName: selectedFabric?.fabricName || null,
      fabricColor: selectedFabric?.colorName || null,
      fabricCode: selectedFabric?.colorCode || null,
      finishName: selectedFinishOpt?.optionName || selectedProduct.finish || null,
      selectedOptions: activeOptionNames,
      asShownPrice: priceCalc.asShownPrice,
    });
  }, [
    retailOnly,
    selectedProduct,
    priceCalc,
    vendorName,
    finishOpts,
    selectedFinishId,
    otherOpts,
    selectedOptions,
    selectedFabric,
  ]);

  // ─── Handlers ──────────────────────────────────────────────────

  const handleSelectProduct = (product: ProductWithPricing) => {
    setSelectedProduct(product);
    setSelectedOptions(new Set());
    setSelectedFinishId(null);
    setOptionTextValues({});
    if (product.gradePrices.length > 0) {
      setSelectedTierId(product.gradePrices[0].tierId);
    } else {
      setSelectedTierId(null);
    }
    setActiveTab("grade");
  };

  const handleSelectGrade = (tierId: number) => {
    setSelectedTierId(tierId);
    // Pre-load fabrics so they're ready when the user reaches the fabric tab
    loadFabrics(tierId);
    setActiveTab("fabric");
  };

  const toggleOption = (optionId: number) => {
    setSelectedOptions((prev) => {
      const next = new Set(prev);
      if (next.has(optionId)) {
        next.delete(optionId);
        setOptionTextValues((t) => {
          const updated = { ...t };
          delete updated[optionId];
          return updated;
        });
      } else {
        next.add(optionId);
      }
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
    Math.ceil(val).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });

  // ─── Tab navigation ────────────────────────────────────────────

  const navigateTab = (direction: 1 | -1) => {
    const currentIndex = TAB_ORDER.indexOf(activeTab);
    let nextIndex = currentIndex + direction;

    // Skip fabric tab if no fabrics exist for the selected grade
    if (TAB_ORDER[nextIndex] === "fabric") {
      const selectedGrade = selectedProduct?.gradePrices.find((gp) => gp.tierId === selectedTierId);
      if ((selectedGrade?.fabricCount ?? 0) === 0) {
        nextIndex += direction;
      }
    }

    // Skip options tab if product has no options (neither finishes nor other options)
    if (TAB_ORDER[nextIndex] === "options" && finishOpts.length === 0 && otherOpts.length === 0) {
      nextIndex += direction;
    }

    if (nextIndex >= 0 && nextIndex < TAB_ORDER.length) {
      setActiveTab(TAB_ORDER[nextIndex]);
    }
  };

  const isNextDisabled = () => {
    if (activeTab === "summary") return true;
    if (activeTab === "product" && !selectedProduct) return true;
    if (activeTab === "grade" && !selectedTierId) return true;
    // Fabric tab is always navigable (fabric selection is optional)
    return false;
  };

  // ─── Tab definitions ──────────────────────────────────────────

  const tabs: StepTabDefinition[] = useMemo(
    () => [
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
        id: "grade",
        label: "Grade",
        icon: <Layers className="w-4 h-4" />,
        subtitle: priceCalc
          ? `${priceCalc.gradeName} / ${formatCurrency(priceCalc.basePrice)}`
          : null,
        disabled: !selectedProduct,
        completed: !!selectedTierId,
      },
      {
        id: "fabric",
        label: "Fabric",
        icon: <Palette className="w-4 h-4" />,
        subtitle: selectedFabric
          ? `${selectedFabric.fabricName} ${selectedFabric.colorName || ""}`.trim().substring(0, 35)
          : null,
        disabled: !selectedProduct || !selectedTierId,
        completed: !!selectedFabric,
      },
      {
        id: "options",
        label: "Options",
        icon: <SlidersHorizontal className="w-4 h-4" />,
        subtitle: (() => {
          const selectedFinish = finishOpts.find((o) => o.optionId === selectedFinishId);
          if (selectedFinish) return selectedFinish.optionName;
          if (selectedOptions.size > 0) return `${selectedOptions.size} selected`;
          return null;
        })(),
        disabled: !selectedProduct || !selectedTierId,
        completed:
          availableOpts.length === 0 || selectedFinishId != null || selectedOptions.size > 0,
      },
      {
        id: "summary",
        label: "Summary",
        icon: <DollarSign className="w-4 h-4" />,
        subtitle: priceCalc ? formatCurrency(priceCalc.asShownPrice) : null,
        disabled: !selectedProduct || !selectedTierId,
      },
    ],
    [
      selectedProduct,
      selectedTierId,
      selectedOptions,
      selectedFinishId,
      selectedFabric,
      priceCalc,
      availableOpts.length,
      finishOpts,
    ],
  );

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
        {/* Sticky search bar — stays pinned while scrolling products */}
        <div className="sticky top-0 z-10 bg-white -mx-4 -mt-4 px-4 pt-4 pb-3 border-b border-sh-gray/10">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sh-gray" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by style number or name..."
              className="w-full border border-sh-gray rounded-lg pl-10 pr-3 py-2 text-sh-black font-serif"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-3">
          {filteredProducts.slice(0, 100).map((p) => {
            const isSelected = selectedProduct?.id === p.id;
            const priceMultiplier = retailOnly ? defaultMarkup : 1;
            const minPrice =
              (p.gradePrices.length > 0
                ? Math.min(...p.gradePrices.map((gp) => gp.cost))
                : p.baseCost || 0) * priceMultiplier;
            const maxPrice =
              (p.gradePrices.length > 0
                ? Math.max(...p.gradePrices.map((gp) => gp.cost))
                : p.baseCost || 0) * priceMultiplier;

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
                <div className="flex items-start gap-3">
                  {p.imageUrl && (
                    <img
                      src={p.imageUrl}
                      alt={p.productNumber}
                      className="w-14 h-14 object-contain flex-shrink-0 rounded bg-white"
                      loading="lazy"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="font-semibold text-sh-black">{p.productNumber}</div>
                        <div className="text-sm text-sh-gray">{p.name}</div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="text-xs text-sh-gray">
                          {p.gradePrices.length > 0
                            ? `${p.gradePrices.length} grades`
                            : "Flat price"}
                        </div>
                        <div className="text-sm font-semibold text-sh-blue tabular-nums">
                          {formatCurrency(minPrice)}
                          {maxPrice > minPrice && ` – ${formatCurrency(maxPrice)}`}
                        </div>
                      </div>
                    </div>
                    {p.description && (
                      <div className="text-xs text-sh-gray mt-1 truncate">{p.description}</div>
                    )}
                    {(p.width || p.depth || p.height) && (
                      <div className="text-xs text-sh-gray/70 mt-0.5">
                        {[
                          p.width && `${p.width}"W`,
                          p.depth && `${p.depth}"D`,
                          p.height && `${p.height}"H`,
                        ]
                          .filter(Boolean)
                          .join(" x ")}
                        {(p.seatHeight || p.armHeight || p.seatDepth) &&
                          ` / ${[
                            p.seatHeight && `SH ${p.seatHeight}"`,
                            p.armHeight && `AH ${p.armHeight}"`,
                            p.seatDepth && `SD ${p.seatDepth}"`,
                          ]
                            .filter(Boolean)
                            .join(" | ")}`}
                      </div>
                    )}
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
            Showing 100 of {filteredProducts.length} — refine your search to see more.
          </div>
        )}
      </StepTabPanel>

      {/* ─── Grade Tab ───────────────────────────────────────── */}
      <StepTabPanel tabId="grade">
        {selectedProduct && (
          <>
            <div className="flex items-center gap-3 mb-4">
              {selectedProduct.imageUrl ? (
                <img
                  src={selectedProduct.imageUrl}
                  alt={selectedProduct.productNumber}
                  className="w-16 h-16 object-contain rounded border border-sh-gray/20 bg-white"
                />
              ) : (
                <Package className="w-5 h-5 text-sh-blue flex-shrink-0" />
              )}
              <div>
                <span className="font-semibold text-sh-black">
                  {selectedProduct.productNumber} — {selectedProduct.name}
                </span>
                {(selectedProduct.width || selectedProduct.depth || selectedProduct.height) && (
                  <div className="text-xs text-sh-gray mt-0.5">
                    {[
                      selectedProduct.width && `${selectedProduct.width}"`,
                      selectedProduct.depth && `${selectedProduct.depth}"D`,
                      selectedProduct.height && `${selectedProduct.height}"H`,
                    ]
                      .filter(Boolean)
                      .join(" x ")}
                  </div>
                )}
                {(selectedProduct.seatHeight ||
                  selectedProduct.armHeight ||
                  selectedProduct.seatDepth) && (
                  <div className="text-xs text-sh-gray mt-0.5">
                    {[
                      selectedProduct.seatHeight && `SH ${selectedProduct.seatHeight}"`,
                      selectedProduct.armHeight && `AH ${selectedProduct.armHeight}"`,
                      selectedProduct.seatDepth && `SD ${selectedProduct.seatDepth}"`,
                    ]
                      .filter(Boolean)
                      .join(" | ")}
                  </div>
                )}
              </div>
            </div>
            <GradePriceGrid
              gradePrices={visibleGrades}
              selectedTierId={selectedTierId}
              onSelect={handleSelectGrade}
              markup={retailOnly ? defaultMarkup : undefined}
            />
            {!retailOnly && selectedProduct.gradeRiser && (
              <div className="mt-3 text-xs text-sh-gray">
                Grade Riser: {formatCurrency(selectedProduct.gradeRiser)} per grade step beyond
                published grades
              </div>
            )}
          </>
        )}
      </StepTabPanel>

      {/* ─── Fabric Tab ──────────────────────────────────────── */}
      <StepTabPanel tabId="fabric">
        {selectedProduct && selectedTierId ? (
          (() => {
            const selectedGrade = selectedProduct.gradePrices.find(
              (gp) => gp.tierId === selectedTierId,
            );
            const fabricCount = selectedGrade?.fabricCount ?? 0;
            const isCOM = selectedGradeTierCode === "COM";

            return (
              <div className="space-y-4">
                {/* Header with grade info */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Palette className="w-5 h-5 text-sh-blue" />
                    <span className="font-semibold text-sh-black">
                      Fabrics in {isCOM ? "COM" : `Grade ${selectedGrade?.tierCode}`}
                    </span>
                    <span className="text-xs text-sh-gray">({fabricCount} available)</span>
                  </div>
                  {selectedFabric && (
                    <span className="text-sm text-sh-blue font-semibold">
                      Selected: {selectedFabric.fabricName} {selectedFabric.colorName}
                    </span>
                  )}
                </div>

                {/* COM Yardage (only when COM grade selected) */}
                {isCOM &&
                  (selectedProduct.comYardage ||
                    selectedProduct.comYardagePattern ||
                    selectedProduct.comYardageRepeat) && (
                    <div className="bg-sh-linen/50 rounded-lg p-4 border border-sh-gray/10">
                      <div className="text-xs text-sh-gray font-sans uppercase tracking-wider mb-2">
                        COM Yardage Required — {selectedProduct.productNumber}
                      </div>
                      <div className="grid grid-cols-3 gap-3 text-sm">
                        {selectedProduct.comYardage != null && (
                          <div className="text-center bg-white rounded-lg p-2 border border-sh-gray/10">
                            <div className="text-sh-black font-semibold">
                              {selectedProduct.comYardage} yds
                            </div>
                            <div className="text-xs text-sh-gray">Plain</div>
                          </div>
                        )}
                        {selectedProduct.comYardagePattern != null && (
                          <div className="text-center bg-white rounded-lg p-2 border border-sh-gray/10">
                            <div className="text-sh-black font-semibold">
                              {selectedProduct.comYardagePattern} yds
                            </div>
                            <div className="text-xs text-sh-gray">Pattern</div>
                          </div>
                        )}
                        {selectedProduct.comYardageRepeat != null && (
                          <div className="text-center bg-white rounded-lg p-2 border border-sh-gray/10">
                            <div className="text-sh-black font-semibold">
                              {selectedProduct.comYardageRepeat} yds
                            </div>
                            <div className="text-xs text-sh-gray">Repeat</div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                {fabricCount > 0 ? (
                  <>
                    {/* Search input — sticky */}
                    <div className="sticky top-0 z-10 bg-white -mx-4 -mt-2 px-4 pt-2 pb-3 border-b border-sh-gray/10">
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sh-gray" />
                        <input
                          type="text"
                          value={fabricSearch}
                          onChange={(e) => setFabricSearch(e.target.value)}
                          placeholder="Search fabrics by name or color..."
                          className="w-full border border-sh-gray/30 rounded-lg pl-9 pr-3 py-2 text-sm text-sh-black font-serif"
                        />
                      </div>
                    </div>

                    {/* Fabric list */}
                    {fabricsLoading ? (
                      <div className="text-center py-12 text-sm text-sh-gray">
                        Loading fabrics...
                      </div>
                    ) : filteredFabrics.length === 0 ? (
                      <div className="text-center py-12 text-sm text-sh-gray">
                        {fabricSearch
                          ? "No fabrics match your search."
                          : "No fabrics found for this grade."}
                      </div>
                    ) : (
                      <div className="divide-y divide-sh-gray/10 border border-sh-gray/10 rounded-lg overflow-hidden">
                        {filteredFabrics.map((f: any) => {
                          const isSelected = selectedFabric?.id === f.id;
                          return (
                            <button
                              key={f.id}
                              onClick={() => setSelectedFabric(isSelected ? null : f)}
                              className={`w-full text-left px-4 py-3 flex items-center justify-between transition min-h-[44px] ${
                                isSelected
                                  ? "bg-sh-linen border-l-4 border-l-sh-blue"
                                  : "hover:bg-sh-linen/30"
                              }`}
                            >
                              <div>
                                <span className="text-sm font-semibold text-sh-black">
                                  {f.fabricName}
                                </span>
                                {f.colorName && (
                                  <span className="text-sm text-sh-gray ml-1.5">{f.colorName}</span>
                                )}
                              </div>
                              <div className="flex items-center gap-2 text-xs text-sh-gray">
                                {f.patternRepeat && (
                                  <span className="bg-sh-gray/10 px-1.5 py-0.5 rounded">
                                    {f.patternRepeat}
                                  </span>
                                )}
                                {f.content && <span className="hidden md:inline">{f.content}</span>}
                                {f.tier?.name && (
                                  <span className="bg-sh-blue/10 text-sh-blue px-1.5 py-0.5 rounded font-semibold">
                                    {f.tier.name}
                                  </span>
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {/* Footer with count */}
                    {filteredFabrics.length > 0 && (
                      <div className="text-xs text-sh-gray">
                        {fabricSearch
                          ? `Showing ${filteredFabrics.length} of ${fabrics.length} fabrics`
                          : `${fabrics.length} fabrics`}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-center py-12 text-sh-gray">
                    <Palette className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    <p className="text-sm">No fabrics in the catalog for this grade.</p>
                    <p className="text-xs text-sh-gray mt-1">
                      Import a fabric catalog from the import page.
                    </p>
                    <Button
                      variant="primary"
                      className="mt-4 min-h-[44px]"
                      onClick={() => navigateTab(1)}
                    >
                      Continue to {availableOpts.length > 0 ? "Options" : "Summary"}{" "}
                      <ChevronRight className="w-4 h-4 ml-1" />
                    </Button>
                  </div>
                )}
              </div>
            );
          })()
        ) : (
          <div className="text-center py-12 text-sh-gray">
            <Palette className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Select a product and grade first.</p>
          </div>
        )}
      </StepTabPanel>

      {/* ─── Options Tab ─────────────────────────────────────── */}
      <StepTabPanel tabId="options">
        {/* Standard construction info */}
        {selectedProduct &&
          (selectedProduct.standardSeat ||
            selectedProduct.standardBack ||
            selectedProduct.standardPillows ||
            selectedProduct.finish) && (
            <div className="bg-sh-linen/50 rounded-lg border border-sh-gray/10 px-4 py-3 mb-4 space-y-1">
              <div className="text-xs font-semibold text-sh-gray uppercase tracking-wide mb-1">
                Standard Construction
              </div>
              {selectedProduct.standardSeat && (
                <div className="text-sm text-sh-black">
                  <span className="text-sh-gray">Seat:</span> {selectedProduct.standardSeat}
                </div>
              )}
              {selectedProduct.standardBack && (
                <div className="text-sm text-sh-black">
                  <span className="text-sh-gray">Back:</span> {selectedProduct.standardBack}
                </div>
              )}
              {selectedProduct.standardPillows && (
                <div className="text-sm text-sh-black">
                  <span className="text-sh-gray">Pillows:</span> {selectedProduct.standardPillows}
                </div>
              )}
              {selectedProduct.finish && (
                <div className="text-sm text-sh-black">
                  <span className="text-sh-gray">Finish:</span> {selectedProduct.finish}
                </div>
              )}
            </div>
          )}

        {/* Wood Finish dropdown (single-select) */}
        {finishOpts.length > 0 && (
          <div className="bg-white rounded-lg border border-sh-gray/20 shadow-sm p-4 mb-4">
            <label className="block text-xs font-semibold text-sh-gray uppercase tracking-wide mb-2">
              Wood Finish
            </label>
            <select
              value={selectedFinishId ?? ""}
              onChange={(e) =>
                setSelectedFinishId(e.target.value ? Number.parseInt(e.target.value) : null)
              }
              className="w-full px-3 py-3 text-sm border border-sh-gray/30 rounded-lg font-serif
                         text-sh-black bg-white appearance-none cursor-pointer
                         focus:outline-none focus:ring-2 focus:ring-sh-blue/30 focus:border-sh-blue"
            >
              <option value="">Select a finish...</option>
              {finishOpts.map((opt) => {
                const displaySurcharge = retailOnly ? opt.surcharge * defaultMarkup : opt.surcharge;
                return (
                  <option key={opt.optionId} value={opt.optionId}>
                    {opt.optionName}
                    {opt.isStandard
                      ? " \u2014 Included"
                      : displaySurcharge > 0
                        ? ` \u2014 +${formatCurrency(displaySurcharge)}`
                        : " \u2014 No charge"}
                  </option>
                );
              })}
            </select>
          </div>
        )}

        {/* Other options (grouped chips) */}
        {otherOpts.length > 0 ? (
          (() => {
            // Group options by groupName
            const groups = new Map<string, typeof otherOpts>();
            for (const opt of otherOpts) {
              const group = groups.get(opt.groupName) || [];
              group.push(opt);
              groups.set(opt.groupName, group);
            }
            return (
              <div className="space-y-4">
                {Array.from(groups.entries()).map(([groupName, groupOpts]) => (
                  <div
                    key={groupName}
                    className="bg-white rounded-lg border border-sh-gray/20 shadow-sm p-4"
                  >
                    <div className="text-xs font-semibold text-sh-gray uppercase tracking-wide mb-3">
                      {groupName}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {groupOpts.map((option) => {
                        const isActive = option.isStandard || selectedOptions.has(option.optionId);
                        const displaySurcharge = retailOnly
                          ? option.surcharge * defaultMarkup
                          : option.surcharge;
                        return (
                          <button
                            key={option.optionId}
                            onClick={() => !option.isStandard && toggleOption(option.optionId)}
                            disabled={option.isStandard}
                            className={`rounded-lg px-4 py-2.5 text-sm font-semibold transition min-h-[44px] ${
                              option.isStandard
                                ? "bg-sh-linen text-sh-black border border-sh-gray/20 cursor-default"
                                : isActive
                                  ? "bg-sh-blue text-white shadow-md"
                                  : "bg-white text-sh-black border border-sh-gray/30 hover:border-sh-blue hover:text-sh-blue"
                            }`}
                          >
                            <span>{option.optionName}</span>
                            <span
                              className={`block text-[11px] font-normal mt-0.5 ${
                                option.isStandard
                                  ? "text-sh-gray"
                                  : isActive
                                    ? "text-white/70"
                                    : "text-sh-gray"
                              }`}
                            >
                              {option.isStandard
                                ? "Included"
                                : displaySurcharge > 0
                                  ? `+${formatCurrency(displaySurcharge)}`
                                  : "No charge"}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {/* Text inputs for active options that require them */}
                    {groupOpts
                      .filter(
                        (o) =>
                          o.requiresTextInput && !o.isStandard && selectedOptions.has(o.optionId),
                      )
                      .map((option) => (
                        <div key={`text-${option.optionId}`} className="mt-3">
                          <input
                            type="text"
                            value={optionTextValues[option.optionId] || ""}
                            onChange={(e) =>
                              setOptionTextValues((prev) => ({
                                ...prev,
                                [option.optionId]: e.target.value,
                              }))
                            }
                            placeholder={option.textInputLabel || `${option.optionName} details...`}
                            className="w-full px-3 py-2 text-sm border border-sh-gray/30 rounded-lg font-serif text-sh-black"
                          />
                        </div>
                      ))}
                  </div>
                ))}
              </div>
            );
          })()
        ) : finishOpts.length === 0 ? (
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
        ) : null}
      </StepTabPanel>

      {/* ─── Summary Tab ─────────────────────────────────────── */}
      <StepTabPanel tabId="summary">
        {priceCalc && selectedProduct ? (
          <div className="w-full max-w-2xl mx-auto space-y-4">
            {/* Product description header */}
            <div className="bg-sh-linen/50 rounded-lg border border-sh-gray/10 p-4">
              <div className="flex items-start gap-4">
                {selectedProduct.imageUrl && (
                  <img
                    src={selectedProduct.imageUrl}
                    alt={selectedProduct.productNumber}
                    className="w-20 h-20 object-contain rounded border border-sh-gray/20 bg-white flex-shrink-0"
                  />
                )}
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="font-semibold text-sh-black text-base">
                    {selectedProduct.productNumber} — {selectedProduct.name}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-sh-gray">
                    <span className="font-semibold text-sh-blue">{priceCalc.gradeName}</span>
                    <span className="tabular-nums">{formatCurrency(priceCalc.basePrice)}</span>
                    {selectedFabric && (
                      <span>
                        {selectedFabric.fabricName}
                        {selectedFabric.colorName ? ` ${selectedFabric.colorName}` : ""}
                      </span>
                    )}
                  </div>
                  {(selectedProduct.width || selectedProduct.depth || selectedProduct.height) && (
                    <div className="text-xs text-sh-gray">
                      {[
                        selectedProduct.width && `${selectedProduct.width}"W`,
                        selectedProduct.depth && `${selectedProduct.depth}"D`,
                        selectedProduct.height && `${selectedProduct.height}"H`,
                      ]
                        .filter(Boolean)
                        .join(" x ")}
                      {(selectedProduct.seatHeight ||
                        selectedProduct.armHeight ||
                        selectedProduct.seatDepth) &&
                        ` | ${[
                          selectedProduct.seatHeight && `SH ${selectedProduct.seatHeight}"`,
                          selectedProduct.armHeight && `AH ${selectedProduct.armHeight}"`,
                          selectedProduct.seatDepth && `SD ${selectedProduct.seatDepth}"`,
                        ]
                          .filter(Boolean)
                          .join(" | ")}`}
                    </div>
                  )}
                  {(() => {
                    const details: string[] = [];
                    const selectedFinishOpt = finishOpts.find(
                      (o) => o.optionId === selectedFinishId,
                    );
                    const displayFinish = selectedFinishOpt?.optionName || selectedProduct.finish;
                    if (displayFinish) details.push(displayFinish);
                    const activeOptions = otherOpts.filter(
                      (o) => o.isStandard || selectedOptions.has(o.optionId),
                    );
                    for (const opt of activeOptions) details.push(opt.optionName);
                    return details.length > 0 ? (
                      <div className="text-xs text-sh-gray">{details.join(" | ")}</div>
                    ) : null;
                  })()}
                </div>
              </div>
            </div>

            {/* Price breakdown */}
            <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-4">
              {retailOnly ? (
                <>
                  {/* Retail-only view: show retail price, options, discount */}
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-sh-black">Retail Price ({priceCalc.gradeName})</span>
                      <span className="font-semibold tabular-nums">
                        {formatCurrency(priceCalc.basePrice * defaultMarkup)}
                      </span>
                    </div>
                    {selectedFabric && (
                      <div className="flex justify-between text-sm">
                        <span className="text-sh-gray flex items-center gap-1">
                          <Palette className="w-3 h-3" />
                          Fabric: {selectedFabric.fabricName} {selectedFabric.colorName}
                        </span>
                        <span className="text-xs text-sh-gray">info only</span>
                      </div>
                    )}
                    {priceCalc.optionLines.map((line, i) => (
                      <div key={i} className="flex justify-between text-sm">
                        <span className="text-sh-gray flex items-center gap-1">
                          <ChevronRight className="w-3 h-3" />
                          {line.label}
                        </span>
                        <span className="tabular-nums">
                          +{formatCurrency(line.amount * defaultMarkup)}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className="border-t border-sh-gray/20 my-3" />

                  <div className="flex justify-between text-base font-semibold">
                    <span className="text-sh-blue">Retail Price</span>
                    <span className="text-sh-black tabular-nums">
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

                  <div className="border-t border-sh-gray/20 my-3" />

                  <div className="flex justify-between text-lg font-semibold">
                    <span className="text-sh-blue">As-Shown Price</span>
                    <span className="text-sh-gold tabular-nums">
                      {formatCurrency(priceCalc.asShownPrice)}
                    </span>
                  </div>
                </>
              ) : (
                <>
                  {/* Full cost view: wholesale, retail, margin */}
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-sh-black">Base Cost ({priceCalc.gradeName})</span>
                      <span className="font-semibold tabular-nums">
                        {formatCurrency(priceCalc.basePrice)}
                      </span>
                    </div>
                    {selectedFabric && (
                      <div className="flex justify-between text-sm">
                        <span className="text-sh-gray flex items-center gap-1">
                          <Palette className="w-3 h-3" />
                          Fabric: {selectedFabric.fabricName} {selectedFabric.colorName}
                        </span>
                        <span className="text-xs text-sh-gray">info only</span>
                      </div>
                    )}
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

                  <div className="border-t border-sh-gray/20 my-3" />

                  <div className="flex justify-between text-base font-semibold">
                    <span className="text-sh-blue">Total Wholesale</span>
                    <span className="text-sh-black tabular-nums">
                      {formatCurrency(priceCalc.totalCost)}
                    </span>
                  </div>

                  <div className="flex justify-between text-sm mt-2">
                    <span className="text-sh-gray">Suggested Retail ({defaultMarkup}x)</span>
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

                  <div className="border-t border-sh-gray/20 my-3" />

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
                        Below MAP ({formatCurrency(priceCalc.mapPrice!)}). Minimum advertised price
                        is enforced.
                      </span>
                    </div>
                  )}

                  <div className="flex justify-between text-sm mt-3">
                    <span className="text-sh-gray">Margin</span>
                    <span
                      className={`font-semibold tabular-nums ${priceCalc.margin >= 0 ? "text-green-700" : "text-red-600"}`}
                    >
                      {formatCurrency(priceCalc.margin)} (
                      {(priceCalc.marginPercent * 100).toFixed(1)}%)
                    </span>
                  </div>
                </>
              )}

              {selectedGradeTierCode === "COM" &&
                (priceCalc.comYardage ||
                  priceCalc.comYardagePattern ||
                  priceCalc.comYardageRepeat) && (
                  <div className="mt-3 pt-3 border-t border-sh-gray/10 space-y-1">
                    <div className="text-xs text-sh-gray font-sans uppercase tracking-wider">
                      COM Yardage Required
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      {priceCalc.comYardage && (
                        <div className="text-center">
                          <div className="text-sh-black font-medium">{priceCalc.comYardage}</div>
                          <div className="text-sh-gray">Plain</div>
                        </div>
                      )}
                      {priceCalc.comYardagePattern && (
                        <div className="text-center">
                          <div className="text-sh-black font-medium">
                            {priceCalc.comYardagePattern}
                          </div>
                          <div className="text-sh-gray">Pattern</div>
                        </div>
                      )}
                      {priceCalc.comYardageRepeat && (
                        <div className="text-center">
                          <div className="text-sh-black font-medium">
                            {priceCalc.comYardageRepeat}
                          </div>
                          <div className="text-sh-gray">Repeat</div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

              {/* the POS entry panel (retail/designer mode only) */}
              {productEntryData && (
                <>
                  <div className="border-t border-sh-gray/20 my-3" />
                  <ProductEntryPanel data={productEntryData} />
                </>
              )}
            </div>

            {/* Add to Quote button (visible when navigated from quote builder) */}
            {onAddToQuote && (
              <button
                onClick={() => {
                  const descParts: string[] = [priceCalc.gradeName];
                  if (selectedFabric) {
                    descParts.push(
                      `${selectedFabric.fabricName}${selectedFabric.colorName ? ` ${selectedFabric.colorName}` : ""}`,
                    );
                  }
                  const selectedFinishOpt = finishOpts.find((o) => o.optionId === selectedFinishId);
                  if (selectedFinishOpt) descParts.push(selectedFinishOpt.optionName);
                  const activeOpts = otherOpts.filter(
                    (o) => o.isStandard || selectedOptions.has(o.optionId),
                  );
                  for (const opt of activeOpts) descParts.push(opt.optionName);
                  const price = retailOnly ? priceCalc.asShownPrice : priceCalc.suggestedRetail;
                  onAddToQuote({
                    productId: selectedProduct.id,
                    productNumber: selectedProduct.productNumber,
                    name: selectedProduct.name || selectedProduct.productNumber,
                    description: descParts.join(", "),
                    price,
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
            <p className="text-sm">Select a product and grade to see the price summary.</p>
          </div>
        )}
      </StepTabPanel>
    </StepTabs>
  );
}
