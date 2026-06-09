// /app/src/components/pricing/SEConfigurator.tsx
//
// Signature Elements configurator -- multi-step wizard for Wesley Hall's
// build-your-own furniture system. Walks through material, piece type,
// depth, base, arm, back, cushion, grade, and finish selections.
// Assembles a SKU from component codes and looks up pricing from
// synthetic VendorStyles (e.g., SE-F21-XLS).

import { useState, useEffect, useMemo, useCallback } from "react";
import { ProductWithPricing, calculatePrice } from "@/lib/pricing/priceCalculator";
import GradePriceGrid from "./GradePriceGrid";
import StepTabs, { StepTabPanel, StepTabDefinition } from "@/components/ui/StepTabs";
import { Button } from "@/components/ui/button";
import {
  Layers,
  SlidersHorizontal,
  DollarSign,
  ChevronRight,
  ChevronLeft,
  AlertTriangle,
  Palette,
} from "lucide-react";
import axios from "axios";

interface SEComponent {
  id: number;
  componentType: string;
  code: string;
  name: string;
  imageUrl: string | null;
  sortOrder: number;
  isDefault: boolean;
  notAvailableInLeather: boolean;
  notAvailableOnSleepers: boolean;
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
  products: ProductWithPricing[];
  vendorId: number;
  vendorName: string;
  defaultMarkup: number;
  defaultDiscount: number;
  mapEnforced: boolean;
  retailOnly?: boolean;
  onAddToQuote?: (item: ConfiguredItemPayload) => void;
}

type SETabId = "build" | "grade" | "fabric" | "summary";
const TAB_ORDER: SETabId[] = ["build", "grade", "fabric", "summary"];

function formatCurrency(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export default function SEConfigurator({
  products,
  vendorId,
  vendorName,
  defaultMarkup,
  defaultDiscount,
  mapEnforced,
  retailOnly = false,
  onAddToQuote,
}: Props) {
  // Component catalog
  const [components, setComponents] = useState<Record<string, SEComponent[]>>({});
  const [componentsLoading, setComponentsLoading] = useState(true);

  // Build selections
  const [material, setMaterial] = useState<"FABRIC" | "LEATHER">("FABRIC");
  const [pieceType, setPieceType] = useState<string | null>(null);
  const [depth, setDepth] = useState<string | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const [arm, setArm] = useState<string | null>(null);
  const [backType, setBackType] = useState<string | null>(null);
  const [cushionFill, setCushionFill] = useState<string | null>(null);
  const [castor, setCastor] = useState<string | null>(null);

  // Grade + fabric selections
  const [selectedGradeTierId, setSelectedGradeTierId] = useState<number | null>(null);
  const [selectedGradeTierCode, setSelectedGradeTierCode] = useState<string | null>(null);
  const [selectedFabric, setSelectedFabric] = useState<{
    fabricName: string;
    colorName: string;
  } | null>(null);
  const [fabrics, setFabrics] = useState<any[]>([]);
  const [fabricSearch, setFabricSearch] = useState("");

  // Tab + discount
  const [activeTab, setActiveTab] = useState<SETabId>("build");
  const [discountPercent, setDiscountPercent] = useState(defaultDiscount);

  // Load components
  useEffect(() => {
    setComponentsLoading(true);
    axios
      .get(`/api/pricing/se-components?vendorId=${vendorId}`)
      .then((res) => {
        setComponents(res.data.components || {});
        // Auto-select defaults
        for (const [, items] of Object.entries(res.data.components || {})) {
          const arr = items as SEComponent[];
          const def = arr.find((c) => c.isDefault);
          if (arr.length > 0) {
            const type = arr[0].componentType;
            const defaultCode = def?.code || arr[0].code;
            if (type === "DEPTH") setDepth(defaultCode);
            if (type === "BASE") setBase(defaultCode);
            if (type === "ARM") setArm(defaultCode);
            if (type === "BACK_TYPE") setBackType(defaultCode);
            if (type === "CUSHION_FILL") setCushionFill(defaultCode);
            if (type === "CASTOR") setCastor(defaultCode);
          }
        }
      })
      .catch(() => {})
      .finally(() => setComponentsLoading(false));
  }, [vendorId]);

  // Determine the synthetic style number from selections
  const styleNumber = useMemo(() => {
    if (!pieceType || !depth) return null;
    const materialCode = material === "FABRIC" ? "F" : "L";
    // Chairs/ottomans/sleepers use "CH" depth code
    const isChair = ["C15", "CMO", "CHR", "MOT", "FSL", "QSL"].includes(pieceType);
    const depthCode = isChair ? "CH" : depth;
    return `SE-${materialCode}${depthCode}-${pieceType}`;
  }, [material, pieceType, depth]);

  // Find the matching product from the loaded SE products
  const selectedProduct = useMemo(() => {
    if (!styleNumber) return null;
    return products.find((p) => p.productNumber === styleNumber) || null;
  }, [styleNumber, products]);

  // Get piece type name
  const pieceTypeName = useMemo(() => {
    const pts = components["PIECE_TYPE"] || [];
    return pts.find((c) => c.code === pieceType)?.name || "";
  }, [components, pieceType]);

  // Is this an armless piece?
  const isArmless = useMemo(() => {
    return ["ARS", "ARL", "ACH", "SOT", "MOT", "CMO"].includes(pieceType || "");
  }, [pieceType]);

  // Is this an ottoman?
  const isOttoman = useMemo(() => {
    return ["SOT", "MOT", "CMO"].includes(pieceType || "");
  }, [pieceType]);

  // Assembled SKU display
  const assembledSku = useMemo(() => {
    const parts: string[] = [];
    if (material === "LEATHER") parts.push("L");
    if (depth) parts.push(depth);
    if (base) parts.push(base);
    if (arm && !isArmless) parts.push(arm);
    if (pieceType) parts.push(pieceType);
    if (backType && !isOttoman) parts.push(backType);
    return parts.join("-") || "---";
  }, [material, depth, base, arm, pieceType, backType, isArmless, isOttoman]);

  // Build set of selected option IDs based on cushion fill choice.
  // "UC" (Ultra Crown) is standard -- no options selected.
  // "CD" or "SD" maps to the Comfort Down / Spring Down option.
  const selectedOptionIds = useMemo(() => {
    const ids = new Set<number>();
    if (!selectedProduct) return ids;
    for (const opt of selectedProduct.availableOptions) {
      if (cushionFill === "CD" && opt.optionName === "Comfort Down") {
        ids.add(opt.optionId);
      }
      if (cushionFill === "SD" && opt.optionName === "Spring Down") {
        ids.add(opt.optionId);
      }
    }
    return ids;
  }, [selectedProduct, cushionFill]);

  // Calculate price
  const priceCalc = useMemo(() => {
    if (!selectedProduct || !selectedGradeTierId) return null;
    return calculatePrice(
      selectedProduct,
      selectedGradeTierId,
      selectedOptionIds,
      defaultMarkup,
      discountPercent,
      mapEnforced,
    );
  }, [
    selectedProduct,
    selectedGradeTierId,
    selectedOptionIds,
    defaultMarkup,
    discountPercent,
    mapEnforced,
  ]);

  // Load fabrics when grade is selected
  useEffect(() => {
    if (!selectedGradeTierCode || !vendorId) return;
    axios
      .get(`/api/pricing/fabrics?vendorId=${vendorId}&tierCode=${selectedGradeTierCode}`)
      .then((res) => setFabrics(res.data.fabrics || []))
      .catch(() => setFabrics([]));
  }, [vendorId, selectedGradeTierCode]);

  const handleGradeSelect = useCallback(
    (tierId: number) => {
      setSelectedGradeTierId(tierId);
      const gp = selectedProduct?.gradePrices?.find((g) => g.tierId === tierId);
      setSelectedGradeTierCode(gp?.tierCode || null);
      setSelectedFabric(null);
      setFabricSearch("");
    },
    [selectedProduct],
  );

  const handleDiscountChange = (val: string) => {
    const num = Number.parseFloat(val);
    if (!Number.isNaN(num) && num >= 0 && num <= 100) {
      setDiscountPercent(num / 100);
    }
  };

  // Navigation
  const goToTab = (tab: SETabId) => setActiveTab(tab);
  const currentTabIndex = TAB_ORDER.indexOf(activeTab);
  const canGoNext = currentTabIndex < TAB_ORDER.length - 1;
  const canGoPrev = currentTabIndex > 0;

  const tabs: StepTabDefinition[] = useMemo(
    () => [
      {
        id: "build",
        label: "Build",
        icon: <Layers className="w-4 h-4" />,
        subtitle: pieceType ? `${pieceTypeName} | ${assembledSku}` : null,
        completed: !!selectedProduct,
      },
      {
        id: "grade",
        label: "Grade",
        icon: <SlidersHorizontal className="w-4 h-4" />,
        subtitle:
          selectedGradeTierCode && priceCalc
            ? `${selectedGradeTierCode} / ${formatCurrency(retailOnly ? priceCalc.basePrice * defaultMarkup : priceCalc.basePrice)}`
            : null,
        disabled: !selectedProduct,
        completed: !!selectedGradeTierId,
      },
      {
        id: "fabric",
        label: "Fabric",
        icon: <Palette className="w-4 h-4" />,
        subtitle: selectedFabric ? `${selectedFabric.fabricName}` : null,
        disabled: !selectedGradeTierId,
        completed: !!selectedFabric,
      },
      {
        id: "summary",
        label: "Summary",
        icon: <DollarSign className="w-4 h-4" />,
        subtitle: priceCalc && selectedGradeTierId ? formatCurrency(priceCalc.asShownPrice) : null,
        disabled: !selectedGradeTierId,
        completed: false,
      },
    ],
    [
      pieceType,
      pieceTypeName,
      assembledSku,
      selectedProduct,
      selectedGradeTierId,
      selectedGradeTierCode,
      selectedFabric,
      priceCalc,
      retailOnly,
      defaultMarkup,
    ],
  );

  // Filter fabrics by search
  const filteredFabrics = useMemo(() => {
    if (!fabricSearch.trim()) return fabrics;
    const q = fabricSearch.toLowerCase();
    return fabrics.filter(
      (f: any) => f.fabricName?.toLowerCase().includes(q) || f.colorName?.toLowerCase().includes(q),
    );
  }, [fabrics, fabricSearch]);

  if (componentsLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-sh-gray">
        Loading components...
      </div>
    );
  }

  const depths = components["DEPTH"] || [];
  const bases = components["BASE"] || [];
  const arms = components["ARM"] || [];
  const backTypes = components["BACK_TYPE"] || [];
  const cushionFills = components["CUSHION_FILL"] || [];
  const pieceTypes = components["PIECE_TYPE"] || [];
  const castors = components["CASTOR"] || [];

  // Bases that support castors: Tapered (1), Turned (2), Block (6), Metal (7)
  const CASTOR_ELIGIBLE_BASES = ["1", "2", "6", "7"];
  const showCastors = !!base && CASTOR_ELIGIBLE_BASES.includes(base) && castors.length > 0;

  return (
    <StepTabs tabs={tabs} activeTab={activeTab} onTabChange={(t) => goToTab(t as SETabId)}>
      {/* ─── Build Tab ─────────────────────────────────────── */}
      <StepTabPanel tabId="build">
        <div className="overflow-y-auto px-1 pb-4 space-y-6">
          {/* Material */}
          <section>
            <h3 className="text-sm font-semibold text-sh-blue mb-2 uppercase tracking-wider font-sans">
              Material
            </h3>
            <div className="flex gap-3">
              {(["FABRIC", "LEATHER"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    setMaterial(m);
                    setSelectedGradeTierId(null);
                    setSelectedGradeTierCode(null);
                    setSelectedFabric(null);
                  }}
                  className={`px-6 py-3 rounded-lg text-sm font-semibold border-2 transition min-w-[120px] ${
                    material === m
                      ? "border-sh-blue bg-sh-linen text-sh-blue"
                      : "border-sh-gray/20 bg-white text-sh-gray hover:border-sh-blue/40"
                  }`}
                >
                  {m === "FABRIC" ? "Fabric" : "Leather"}
                </button>
              ))}
            </div>
          </section>

          {/* Piece Type */}
          <section>
            <h3 className="text-sm font-semibold text-sh-blue mb-2 uppercase tracking-wider font-sans">
              Piece Type
            </h3>
            <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
              {pieceTypes
                .filter((pt) => !(material === "LEATHER" && pt.notAvailableInLeather))
                .map((pt) => (
                  <button
                    key={pt.code}
                    onClick={() => {
                      setPieceType(pt.code);
                      setSelectedGradeTierId(null);
                      setSelectedGradeTierCode(null);
                    }}
                    className={`p-3 rounded-lg text-sm border-2 transition text-left ${
                      pieceType === pt.code
                        ? "border-sh-blue bg-sh-linen text-sh-blue font-semibold"
                        : "border-sh-gray/20 bg-white text-sh-black hover:border-sh-blue/40"
                    }`}
                  >
                    <div className="font-medium">{pt.name}</div>
                    <div className="text-xs text-sh-gray mt-0.5">{pt.code}</div>
                  </button>
                ))}
            </div>
          </section>

          {/* Depth (only for non-chair piece types) */}
          {pieceType && !["C15", "CMO", "CHR", "MOT", "FSL", "QSL"].includes(pieceType) && (
            <section>
              <h3 className="text-sm font-semibold text-sh-blue mb-2 uppercase tracking-wider font-sans">
                Depth
              </h3>
              <div className="flex gap-3">
                {depths.map((d) => (
                  <button
                    key={d.code}
                    onClick={() => {
                      setDepth(d.code);
                      setSelectedGradeTierId(null);
                      setSelectedGradeTierCode(null);
                    }}
                    className={`px-6 py-3 rounded-lg text-sm border-2 transition ${
                      depth === d.code
                        ? "border-sh-blue bg-sh-linen text-sh-blue font-semibold"
                        : "border-sh-gray/20 bg-white text-sh-gray hover:border-sh-blue/40"
                    }`}
                  >
                    {d.name}
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Base */}
          <section>
            <h3 className="text-sm font-semibold text-sh-blue mb-2 uppercase tracking-wider font-sans">
              Base
            </h3>
            <div className="grid grid-cols-4 md:grid-cols-5 gap-2">
              {bases.map((b) => (
                <button
                  key={b.code}
                  onClick={() => {
                    setBase(b.code);
                    if (!CASTOR_ELIGIBLE_BASES.includes(b.code)) setCastor(null);
                  }}
                  className={`p-3 rounded-lg text-sm border-2 transition text-center ${
                    base === b.code
                      ? "border-sh-blue bg-sh-linen text-sh-blue font-semibold"
                      : "border-sh-gray/20 bg-white text-sh-black hover:border-sh-blue/40"
                  }`}
                >
                  <div className="font-medium text-xs">{b.name}</div>
                </button>
              ))}
            </div>
          </section>

          {/* Castors (only for leg-type bases) */}
          {showCastors && (
            <section>
              <h3 className="text-sm font-semibold text-sh-blue mb-2 uppercase tracking-wider font-sans">
                Castors
              </h3>
              <div className="flex gap-3 flex-wrap">
                {castors.map((c) => (
                  <button
                    key={c.code}
                    onClick={() => setCastor(c.code)}
                    className={`px-5 py-3 rounded-lg text-sm border-2 transition ${
                      castor === c.code
                        ? "border-sh-blue bg-sh-linen text-sh-blue font-semibold"
                        : "border-sh-gray/20 bg-white text-sh-gray hover:border-sh-blue/40"
                    }`}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Arm (skip for armless pieces) */}
          {!isArmless && (
            <section>
              <h3 className="text-sm font-semibold text-sh-blue mb-2 uppercase tracking-wider font-sans">
                Arm Style
              </h3>
              <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
                {arms.map((a) => (
                  <button
                    key={a.code}
                    onClick={() => setArm(a.code)}
                    className={`p-3 rounded-lg text-sm border-2 transition text-center ${
                      arm === a.code
                        ? "border-sh-blue bg-sh-linen text-sh-blue font-semibold"
                        : "border-sh-gray/20 bg-white text-sh-black hover:border-sh-blue/40"
                    }`}
                  >
                    <div className="font-medium text-xs">{a.name}</div>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Back Type (skip for ottomans) */}
          {!isOttoman && (
            <section>
              <h3 className="text-sm font-semibold text-sh-blue mb-2 uppercase tracking-wider font-sans">
                Back Type
              </h3>
              <div className="grid grid-cols-3 md:grid-cols-4 gap-2">
                {backTypes.map((bt) => (
                  <button
                    key={bt.code}
                    onClick={() => setBackType(bt.code)}
                    className={`p-3 rounded-lg text-sm border-2 transition text-center ${
                      backType === bt.code
                        ? "border-sh-blue bg-sh-linen text-sh-blue font-semibold"
                        : "border-sh-gray/20 bg-white text-sh-black hover:border-sh-blue/40"
                    }`}
                  >
                    <div className="font-medium text-xs">{bt.name}</div>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Cushion Fill */}
          <section>
            <h3 className="text-sm font-semibold text-sh-blue mb-2 uppercase tracking-wider font-sans">
              Cushion Fill
            </h3>
            <div className="flex gap-3 flex-wrap">
              {cushionFills.map((cf) => (
                <button
                  key={cf.code}
                  onClick={() => setCushionFill(cf.code)}
                  className={`px-5 py-3 rounded-lg text-sm border-2 transition ${
                    cushionFill === cf.code
                      ? "border-sh-blue bg-sh-linen text-sh-blue font-semibold"
                      : "border-sh-gray/20 bg-white text-sh-gray hover:border-sh-blue/40"
                  }`}
                >
                  {cf.name}
                </button>
              ))}
            </div>
          </section>

          {/* Assembled SKU + status */}
          <div className="bg-sh-linen/50 rounded-lg border border-sh-gray/10 p-4 flex items-center justify-between">
            <div>
              <div className="text-xs text-sh-gray font-sans uppercase tracking-wider mb-1">
                Assembled SKU
              </div>
              <div className="text-lg font-semibold text-sh-blue font-mono tracking-wide">
                {assembledSku}
              </div>
              {pieceType && (
                <div className="text-sm text-sh-gray mt-1">
                  {material === "FABRIC" ? "Fabric" : "Leather"} {pieceTypeName}
                  {styleNumber && !selectedProduct && (
                    <span className="text-red-500 ml-2 text-xs">
                      (pricing not imported for {styleNumber})
                    </span>
                  )}
                </div>
              )}
            </div>
            {selectedProduct && (
              <Button
                onClick={() => goToTab("grade")}
                className="bg-sh-blue text-white hover:bg-sh-blue/90"
              >
                Select Grade <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            )}
          </div>
        </div>
      </StepTabPanel>

      {/* ─── Grade Tab ─────────────────────────────────────── */}
      <StepTabPanel tabId="grade">
        {selectedProduct && selectedProduct.gradePrices ? (
          <div className="overflow-y-auto px-1 pb-4">
            <div className="mb-4">
              <h3 className="text-sm font-semibold text-sh-blue mb-1">
                Select {material === "FABRIC" ? "Fabric" : "Leather"} Grade
              </h3>
              <p className="text-xs text-sh-gray">
                {pieceTypeName} ({styleNumber})
              </p>
            </div>
            <GradePriceGrid
              gradePrices={selectedProduct.gradePrices}
              selectedTierId={selectedGradeTierId}
              onSelect={(tierId) => {
                handleGradeSelect(tierId);
                // Auto-advance to fabric tab
                setTimeout(() => goToTab("fabric"), 150);
              }}
              markup={retailOnly ? defaultMarkup : undefined}
            />

            <div className="flex justify-between mt-6">
              <Button
                variant="outline"
                onClick={() => goToTab("build")}
                className="text-sh-gray border-sh-gray"
              >
                <ChevronLeft className="w-4 h-4 mr-1" /> Back to Build
              </Button>
              {selectedGradeTierId && (
                <Button
                  onClick={() => goToTab("fabric")}
                  className="bg-sh-blue text-white hover:bg-sh-blue/90"
                >
                  {material === "FABRIC" ? "Select Fabric" : "Continue"}{" "}
                  <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="text-center py-16 text-sh-gray">
            Select a piece type and depth first to see grade pricing.
          </div>
        )}
      </StepTabPanel>

      {/* ─── Fabric Tab ────────────────────────────────────── */}
      <StepTabPanel tabId="fabric">
        <div className="overflow-y-auto px-1 pb-4">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-sh-blue">
                {material === "FABRIC" ? "Select Fabric" : "Select Leather"}
              </h3>
              <p className="text-xs text-sh-gray">
                Grade {selectedGradeTierCode} - {fabrics.length} options
              </p>
            </div>
            <input
              type="text"
              placeholder="Search fabrics..."
              value={fabricSearch}
              onChange={(e) => setFabricSearch(e.target.value)}
              className="border border-sh-gray/30 rounded-lg px-3 py-2 text-sm w-48"
            />
          </div>

          {filteredFabrics.length > 0 ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
              {filteredFabrics.map((f: any, i: number) => (
                <button
                  key={i}
                  onClick={() => {
                    setSelectedFabric({ fabricName: f.fabricName, colorName: f.colorName || "" });
                    setTimeout(() => goToTab("summary"), 150);
                  }}
                  className={`p-3 rounded-lg text-sm border-2 transition text-left ${
                    selectedFabric?.fabricName === f.fabricName &&
                    selectedFabric?.colorName === (f.colorName || "")
                      ? "border-sh-blue bg-sh-linen"
                      : "border-sh-gray/20 bg-white hover:border-sh-blue/40"
                  }`}
                >
                  <div className="font-medium text-sh-black truncate">{f.fabricName}</div>
                  {f.colorName && (
                    <div className="text-xs text-sh-gray truncate">{f.colorName}</div>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-sh-gray text-sm">
              {fabrics.length === 0
                ? "No fabrics available for this grade."
                : "No fabrics match your search."}
            </div>
          )}

          <div className="flex justify-between mt-6">
            <Button
              variant="outline"
              onClick={() => goToTab("grade")}
              className="text-sh-gray border-sh-gray"
            >
              <ChevronLeft className="w-4 h-4 mr-1" /> Back to Grade
            </Button>
            <Button
              onClick={() => goToTab("summary")}
              className="bg-sh-blue text-white hover:bg-sh-blue/90"
            >
              View Summary <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </div>
        </div>
      </StepTabPanel>

      {/* ─── Summary Tab ───────────────────────────────────── */}
      <StepTabPanel tabId="summary">
        {priceCalc && selectedProduct ? (
          <div className="w-full max-w-2xl mx-auto space-y-4 pb-4">
            {/* Product header */}
            <div className="bg-sh-linen/50 rounded-lg border border-sh-gray/10 p-4">
              <div className="space-y-1">
                <div className="font-semibold text-sh-black text-base">
                  {vendorName} Signature Elements
                </div>
                <div className="text-sm text-sh-gray">
                  {material === "FABRIC" ? "Fabric" : "Leather"} {pieceTypeName}
                </div>
                <div className="font-mono text-sm text-sh-blue tracking-wide mt-2">
                  SKU: {assembledSku}
                </div>
                <div className="text-xs text-sh-gray">
                  Style: {styleNumber} | Grade: {selectedGradeTierCode}
                  {selectedFabric && (
                    <>
                      {" "}
                      | {selectedFabric.fabricName}
                      {selectedFabric.colorName ? ` ${selectedFabric.colorName}` : ""}
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Price breakdown */}
            <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-sh-black">
                    {retailOnly ? "Base Price" : "Base Cost"} ({selectedGradeTierCode})
                  </span>
                  <span className="font-semibold tabular-nums">
                    {formatCurrency(
                      retailOnly ? priceCalc.basePrice * defaultMarkup : priceCalc.basePrice,
                    )}
                  </span>
                </div>

                {selectedFabric && (
                  <div className="flex justify-between text-sm">
                    <span className="text-sh-gray flex items-center gap-1">
                      <Palette className="w-3 h-3" />
                      {selectedFabric.fabricName} {selectedFabric.colorName}
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
                      +{formatCurrency(retailOnly ? line.amount * defaultMarkup : line.amount)}
                    </span>
                  </div>
                ))}
              </div>

              <div className="border-t border-sh-gray/20 my-4" />

              {!retailOnly && (
                <>
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
                </>
              )}

              {retailOnly && (
                <div className="flex justify-between text-base font-semibold">
                  <span className="text-sh-blue">Retail Price</span>
                  <span className="text-sh-black tabular-nums">
                    {formatCurrency(priceCalc.suggestedRetail)}
                  </span>
                </div>
              )}

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
                    : "—"}
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

            {/* Component selections summary */}
            <div className="bg-white rounded-lg border border-sh-gray/20 p-4">
              <h3 className="text-xs font-semibold text-sh-gray uppercase tracking-wider mb-3 font-sans">
                Component Selections
              </h3>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="text-sh-gray">Material</div>
                <div className="text-sh-black font-medium">
                  {material === "FABRIC" ? "Fabric" : "Leather"}
                </div>
                <div className="text-sh-gray">Piece Type</div>
                <div className="text-sh-black font-medium">{pieceTypeName}</div>
                <div className="text-sh-gray">Depth</div>
                <div className="text-sh-black font-medium">
                  {depths.find((d) => d.code === depth)?.name || depth}
                </div>
                <div className="text-sh-gray">Base</div>
                <div className="text-sh-black font-medium">
                  {bases.find((b) => b.code === base)?.name || base}
                </div>
                {showCastors && castor && (
                  <>
                    <div className="text-sh-gray">Castors</div>
                    <div className="text-sh-black font-medium">
                      {castors.find((c) => c.code === castor)?.name || castor}
                    </div>
                  </>
                )}
                {!isArmless && (
                  <>
                    <div className="text-sh-gray">Arm</div>
                    <div className="text-sh-black font-medium">
                      {arms.find((a) => a.code === arm)?.name || arm}
                    </div>
                  </>
                )}
                {!isOttoman && (
                  <>
                    <div className="text-sh-gray">Back Type</div>
                    <div className="text-sh-black font-medium">
                      {backTypes.find((bt) => bt.code === backType)?.name || backType}
                    </div>
                  </>
                )}
                <div className="text-sh-gray">Cushion Fill</div>
                <div className="text-sh-black font-medium">
                  {cushionFills.find((cf) => cf.code === cushionFill)?.name || cushionFill}
                </div>
              </div>
            </div>

            <div className="flex justify-start">
              <Button
                variant="outline"
                onClick={() => goToTab("build")}
                className="text-sh-gray border-sh-gray"
              >
                <ChevronLeft className="w-4 h-4 mr-1" /> Modify Build
              </Button>
            </div>

            {onAddToQuote && (
              <button
                onClick={() => {
                  const descParts: string[] = [
                    material === "FABRIC" ? "Fabric" : "Leather",
                    pieceTypeName,
                  ];
                  if (depth) {
                    const depthName = depths.find((d) => d.code === depth)?.name;
                    if (depthName) descParts.push(depthName);
                  }
                  if (base) {
                    const baseName = bases.find((b) => b.code === base)?.name;
                    if (baseName) descParts.push(`Base: ${baseName}`);
                  }
                  if (arm && !isArmless) {
                    const armName = arms.find((a) => a.code === arm)?.name;
                    if (armName) descParts.push(`Arm: ${armName}`);
                  }
                  if (backType && !isOttoman) {
                    const backName = backTypes.find((bt) => bt.code === backType)?.name;
                    if (backName) descParts.push(`Back: ${backName}`);
                  }
                  if (cushionFill) {
                    const fillName = cushionFills.find((cf) => cf.code === cushionFill)?.name;
                    if (fillName) descParts.push(fillName);
                  }
                  if (selectedGradeTierCode) descParts.push(`Grade ${selectedGradeTierCode}`);
                  if (selectedFabric) descParts.push(selectedFabric.fabricName);
                  onAddToQuote({
                    productId: selectedProduct.id,
                    productNumber: selectedProduct.productNumber,
                    name: selectedProduct.name || selectedProduct.productNumber,
                    description: descParts.join(", "),
                    price: retailOnly ? priceCalc.asShownPrice : priceCalc.suggestedRetail,
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
          <div className="text-center py-16 text-sh-gray">
            <p>Complete your build selections and choose a grade to see pricing.</p>
            <Button
              onClick={() => goToTab("build")}
              className="mt-4 bg-sh-blue text-white hover:bg-sh-blue/90"
            >
              <ChevronLeft className="w-4 h-4 mr-1" /> Back to Build
            </Button>
          </div>
        )}
      </StepTabPanel>
    </StepTabs>
  );
}
