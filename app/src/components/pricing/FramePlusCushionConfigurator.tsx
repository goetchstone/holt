// /app/src/components/pricing/FramePlusCushionConfigurator.tsx
//
// Interactive configurator for frame+cushion vendors (Kingsley Bate).
// Tab flow: Frame -> Finish -> Grade -> Fabric -> Summary
// Finish tab lets users select a finish and opt-in to cushion.
// Grade/Fabric tabs are conditional on the user choosing to include a cushion.

import { useState, useMemo, useEffect, useCallback } from "react";
import { calculateFramePlusCushionPrice, CushionGradePrice } from "@/lib/pricing/priceCalculator";
import StepTabs, { StepTabPanel, StepTabDefinition } from "@/components/ui/StepTabs";
import { Button } from "@/components/ui/button";
import {
  Search,
  Package,
  Layers,
  DollarSign,
  ChevronRight,
  ChevronLeft,
  Palette,
  ShieldCheck,
} from "lucide-react";
import axios from "axios";

// ─── Types ────────────────────────────────────────────────────────

interface FrameProduct {
  id: number;
  productNumber: string;
  name: string;
  description: string | null;
  framePrice: number;
  cushionRef: string | null;
  finish: string | null;
  collection: string | null;
  width: number | null;
  depth: number | null;
  height: number | null;
  imageUrl: string | null;
  gradePrices: CushionGradePrice[];
}

interface CushionProduct {
  id: number;
  cushionCode: string;
  name: string;
  description: string | null;
  comYardage: number | null;
  gradePrices: CushionGradePrice[];
}

interface CoverProduct {
  id: number;
  coverCode: string;
  name: string;
  description: string | null;
  retailPrice: number | null;
  fitsFrame: string | null;
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
  frames: FrameProduct[];
  cushions: CushionProduct[];
  covers: CoverProduct[];
  vendorId: number;
  vendorName: string;
  retailOnly?: boolean;
  costMultiplier?: number | null;
  onAddToQuote?: (item: ConfiguredItemPayload) => void;
}

interface ParsedFinish {
  material: string;
  codes: string[];
  isStocked: boolean;
}

type TabId = "frame" | "finish" | "grade" | "fabric" | "summary";

const TAB_ORDER: TabId[] = ["frame", "finish", "grade", "fabric", "summary"];

// ─── Helpers ──────────────────────────────────────────────────────

function parseFinishString(finish: string | null): ParsedFinish[] {
  if (!finish) return [];

  const soMarker = "SPECIAL ORDER:";
  const stMarker = "STOCKED:";
  const soIdx = finish.indexOf(soMarker);
  const stIdx = finish.indexOf(stMarker);

  let stockedRaw = "";
  let specialRaw = "";

  if (stIdx >= 0 && soIdx >= 0) {
    stockedRaw = finish
      .substring(stIdx + stMarker.length, soIdx)
      .replace(/\s*\|\s*$/, "")
      .trim();
    specialRaw = finish.substring(soIdx + soMarker.length).trim();
  } else if (stIdx >= 0) {
    stockedRaw = finish.substring(stIdx + stMarker.length).trim();
  } else if (soIdx >= 0) {
    specialRaw = finish.substring(soIdx + soMarker.length).trim();
  } else {
    stockedRaw = finish.trim();
  }

  const parseEntries = (raw: string, stocked: boolean): ParsedFinish[] => {
    if (!raw) return [];
    return raw
      .split(" | ")
      .filter(Boolean)
      .map((entry) => {
        const colIdx = entry.indexOf(":");
        if (colIdx >= 0) {
          return {
            material: entry.substring(0, colIdx).trim(),
            codes: entry
              .substring(colIdx + 1)
              .trim()
              .split(/,\s*/),
            isStocked: stocked,
          };
        }
        return { material: entry.trim(), codes: [], isStocked: stocked };
      });
  };

  return [...parseEntries(stockedRaw, true), ...parseEntries(specialRaw, false)];
}

function finishLabel(pf: ParsedFinish): string {
  if (pf.codes.length === 0) return pf.material;
  return `${pf.material}: ${pf.codes.join(", ")}`;
}

const formatCurrency = (val: number) =>
  val.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
  });

// ─── Component ────────────────────────────────────────────────────

export default function FramePlusCushionConfigurator({
  frames,
  cushions,
  covers,
  vendorId,
  vendorName,
  retailOnly = false,
  costMultiplier = null,
  onAddToQuote,
}: Props) {
  const [activeTab, setActiveTab] = useState<TabId>("frame");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFrame, setSelectedFrame] = useState<FrameProduct | null>(null);
  const [selectedTierId, setSelectedTierId] = useState<number | null>(null);

  // Finish state
  const [selectedFinish, setSelectedFinish] = useState<ParsedFinish | null>(null);
  const [includeCushion, setIncludeCushion] = useState(true);

  // Fabric state
  const [fabricSearch, setFabricSearch] = useState("");
  const [fabrics, setFabrics] = useState<any[]>([]);
  const [fabricsLoading, setFabricsLoading] = useState(false);
  const [fabricTierLoaded, setFabricTierLoaded] = useState<number | null>(null);
  const [selectedFabric, setSelectedFabric] = useState<any | null>(null);

  // Build a lookup: cushionCode -> CushionProduct
  const cushionMap = useMemo(() => {
    const map = new Map<string, CushionProduct>();
    for (const c of cushions) {
      map.set(c.cushionCode, c);
    }
    return map;
  }, [cushions]);

  // Linked cushion for the selected frame
  const linkedCushion = useMemo(() => {
    if (!selectedFrame?.cushionRef) return null;
    return cushionMap.get(selectedFrame.cushionRef) ?? null;
  }, [selectedFrame, cushionMap]);

  // Parsed finishes for the selected frame
  const parsedFinishes = useMemo(
    () => parseFinishString(selectedFrame?.finish ?? null),
    [selectedFrame],
  );
  const stockedFinishes = useMemo(
    () => parsedFinishes.filter((f) => f.isStocked),
    [parsedFinishes],
  );
  const specialOrderFinishes = useMemo(
    () => parsedFinishes.filter((f) => !f.isStocked),
    [parsedFinishes],
  );

  // Whether the finish tab has any content to show
  const hasFinishContent = parsedFinishes.length > 0 || !!linkedCushion;

  // Matching covers for the selected frame
  const matchingCovers = useMemo(() => {
    if (!selectedFrame) return [];
    return covers.filter((c) => c.fitsFrame === selectedFrame.productNumber);
  }, [selectedFrame, covers]);

  // Load fabrics for a given tier
  const loadFabrics = useCallback(
    async (tierId: number) => {
      if (fabricTierLoaded === tierId && fabrics.length > 0) return;
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

  // Load fabrics when the fabric tab is active
  useEffect(() => {
    if (activeTab === "fabric" && selectedTierId) {
      loadFabrics(selectedTierId);
    }
  }, [activeTab, selectedTierId, loadFabrics]);

  // Reset fabric state when frame changes
  useEffect(() => {
    setFabrics([]);
    setFabricTierLoaded(null);
    setSelectedFabric(null);
    setFabricSearch("");
  }, [selectedFrame]);

  // Reset fabric list when grade changes
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

  // Filter frames by search
  const filteredFrames = useMemo(() => {
    if (!searchQuery.trim()) return frames;
    const q = searchQuery.toLowerCase();
    return frames.filter(
      (f) =>
        f.productNumber.toLowerCase().includes(q) ||
        f.name.toLowerCase().includes(q) ||
        (f.description && f.description.toLowerCase().includes(q)) ||
        (f.collection && f.collection.toLowerCase().includes(q)),
    );
  }, [frames, searchQuery]);

  // Price calculation -- derive cushion component from the frame's combined price.
  // The frame section's gradePrices store combined (frame+cushion) retail totals.
  // Cushion component = combined price - frame-only price.
  const selectedGradePrice = useMemo(() => {
    if (!includeCushion || !linkedCushion || !selectedTierId || !selectedFrame) return null;
    const gp = selectedFrame.gradePrices.find((g) => g.tierId === selectedTierId);
    if (!gp?.retail) return null;
    return gp.retail - selectedFrame.framePrice;
  }, [selectedFrame, selectedTierId, includeCushion, linkedCushion]);

  const priceCalc = useMemo(() => {
    if (!selectedFrame) return null;
    const cushionPrice = includeCushion ? selectedGradePrice : null;
    return calculateFramePlusCushionPrice(
      selectedFrame.framePrice,
      cushionPrice,
      [],
      undefined,
      costMultiplier,
    );
  }, [selectedFrame, selectedGradePrice, includeCushion, costMultiplier]);

  const showCost = !retailOnly && costMultiplier != null;

  // ─── Handlers ────────────────────────────────────────────────────

  const handleSelectFrame = (frame: FrameProduct) => {
    setSelectedFrame(frame);
    setSelectedTierId(null);
    setSelectedFinish(null);
    setIncludeCushion(true);

    const finishes = parseFinishString(frame.finish);
    const hasCushion = !!(frame.cushionRef && cushionMap.has(frame.cushionRef));

    if (finishes.length > 0 || hasCushion) {
      setActiveTab("finish");
    } else {
      setActiveTab("summary");
    }
  };

  const handleSelectGrade = (tierId: number) => {
    setSelectedTierId(tierId);
    loadFabrics(tierId);
    setActiveTab("fabric");
  };

  const handleCushionToggle = () => {
    const next = !includeCushion;
    setIncludeCushion(next);
    if (!next) {
      setSelectedTierId(null);
      setSelectedFabric(null);
      setFabrics([]);
      setFabricTierLoaded(null);
      setFabricSearch("");
    }
  };

  // ─── Tab navigation ──────────────────────────────────────────────

  const shouldSkipTab = (tabId: TabId): boolean => {
    if (tabId === "finish" && !hasFinishContent) return true;
    if (
      tabId === "grade" &&
      (!includeCushion || !linkedCushion || !selectedFrame?.gradePrices.length)
    )
      return true;
    if (tabId === "fabric" && (!includeCushion || !linkedCushion)) return true;
    return false;
  };

  const navigateTab = (direction: 1 | -1) => {
    let idx = TAB_ORDER.indexOf(activeTab) + direction;
    while (idx >= 0 && idx < TAB_ORDER.length && shouldSkipTab(TAB_ORDER[idx])) {
      idx += direction;
    }
    if (idx >= 0 && idx < TAB_ORDER.length) {
      setActiveTab(TAB_ORDER[idx]);
    }
  };

  const isNextDisabled = () => {
    if (activeTab === "summary") return true;
    if (activeTab === "frame" && !selectedFrame) return true;
    if (activeTab === "grade" && !selectedTierId) return true;
    return false;
  };

  // ─── Selected grade tier info ───────────────────────────────────

  const selectedGradeTier = useMemo(() => {
    if (!selectedFrame || !selectedTierId) return null;
    return selectedFrame.gradePrices.find((g) => g.tierId === selectedTierId) ?? null;
  }, [selectedFrame, selectedTierId]);

  // ─── Tab definitions ────────────────────────────────────────────

  const tabs: StepTabDefinition[] = useMemo(
    () => [
      {
        id: "frame",
        label: "Frame",
        icon: <Package className="w-4 h-4" />,
        subtitle: selectedFrame
          ? `${selectedFrame.productNumber} ${selectedFrame.name}`.substring(0, 40)
          : null,
        completed: !!selectedFrame,
      },
      {
        id: "finish",
        label: "Finish",
        icon: <ShieldCheck className="w-4 h-4" />,
        subtitle: selectedFinish ? finishLabel(selectedFinish) : null,
        disabled: !selectedFrame || !hasFinishContent,
        completed: !!selectedFinish || (hasFinishContent && parsedFinishes.length === 0),
      },
      {
        id: "grade",
        label: "Grade",
        icon: <Layers className="w-4 h-4" />,
        subtitle: selectedGradeTier
          ? `Grade ${selectedGradeTier.tierCode} / ${formatCurrency(selectedGradeTier.retail ?? 0)}`
          : null,
        disabled:
          !selectedFrame || !includeCushion || !linkedCushion || !selectedFrame.gradePrices.length,
        completed: !!selectedTierId,
      },
      {
        id: "fabric",
        label: "Fabric",
        icon: <Palette className="w-4 h-4" />,
        subtitle: selectedFabric
          ? `${selectedFabric.fabricName} ${selectedFabric.colorName || ""}`.trim().substring(0, 35)
          : null,
        disabled: !selectedFrame || !includeCushion || !selectedTierId,
        completed: !!selectedFabric,
      },
      {
        id: "summary",
        label: "Summary",
        icon: <DollarSign className="w-4 h-4" />,
        subtitle: priceCalc ? formatCurrency(priceCalc.totalRetail) : null,
        disabled: !selectedFrame,
      },
    ],
    [
      selectedFrame,
      selectedFinish,
      selectedTierId,
      selectedFabric,
      selectedGradeTier,
      priceCalc,
      linkedCushion,
      includeCushion,
      hasFinishContent,
      parsedFinishes.length,
    ],
  );

  // ─── Render ────────────────────────────────────────────────────

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
            disabled={activeTab === "frame"}
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
      {/* ─── Frame Tab ─────────────────────────────────────── */}
      <StepTabPanel tabId="frame">
        <div className="sticky top-0 z-10 bg-white -mx-4 -mt-4 px-4 pt-4 pb-3 border-b border-sh-gray/10">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sh-gray" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by style number, name, or collection..."
              className="w-full border border-sh-gray rounded-lg pl-10 pr-3 py-2 text-sh-black font-serif"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-3">
          {filteredFrames.slice(0, 100).map((f) => {
            const isSelected = selectedFrame?.id === f.id;
            const cushion = f.cushionRef ? cushionMap.get(f.cushionRef) : null;

            return (
              <button
                key={f.id}
                onClick={() => handleSelectFrame(f)}
                className={`text-left rounded-lg border-2 p-4 transition-all ${
                  isSelected
                    ? "border-sh-blue bg-sh-linen shadow-md"
                    : "border-sh-gray/20 bg-white hover:border-sh-blue/40 hover:shadow-sm"
                }`}
              >
                <div className="flex items-start gap-3">
                  {f.imageUrl && (
                    <img
                      src={f.imageUrl}
                      alt={f.productNumber}
                      className="w-14 h-14 object-contain flex-shrink-0 rounded bg-white"
                      loading="lazy"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="font-semibold text-sh-black">{f.productNumber}</div>
                        <div className="text-sm text-sh-gray">{f.name}</div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="text-sm font-semibold text-sh-blue tabular-nums">
                          {formatCurrency(f.framePrice)}
                        </div>
                        {cushion && <div className="text-xs text-sh-gray">+ {f.cushionRef}</div>}
                        {!cushion && !f.cushionRef && (
                          <div className="text-xs text-sh-gray">Frame only</div>
                        )}
                      </div>
                    </div>
                    {f.collection && (
                      <div className="text-xs text-sh-gray mt-1">{f.collection}</div>
                    )}
                    {(f.width || f.depth || f.height) && (
                      <div className="text-xs text-sh-gray/70 mt-0.5">
                        {[
                          f.width && `${f.width}"W`,
                          f.depth && `${f.depth}"D`,
                          f.height && `${f.height}"H`,
                        ]
                          .filter(Boolean)
                          .join(" x ")}
                      </div>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
        {filteredFrames.length === 0 && (
          <div className="text-center py-8 text-sh-gray">No frames match your search.</div>
        )}
        {filteredFrames.length > 100 && (
          <div className="text-center py-2 text-sm text-sh-gray">
            Showing 100 of {filteredFrames.length} -- refine your search to see more.
          </div>
        )}
      </StepTabPanel>

      {/* ─── Finish Tab ────────────────────────────────────── */}
      <StepTabPanel tabId="finish">
        {selectedFrame && (
          <div className="max-w-lg mx-auto space-y-6">
            {/* Frame context */}
            <div className="flex items-center gap-3">
              {selectedFrame.imageUrl ? (
                <img
                  src={selectedFrame.imageUrl}
                  alt={selectedFrame.productNumber}
                  className="w-16 h-16 object-contain rounded border border-sh-gray/20 bg-white"
                />
              ) : (
                <Package className="w-5 h-5 text-sh-blue flex-shrink-0" />
              )}
              <div>
                <span className="font-semibold text-sh-black">
                  {selectedFrame.productNumber} -- {selectedFrame.name}
                </span>
                <div className="text-sm text-sh-gray mt-0.5">
                  Frame: {formatCurrency(selectedFrame.framePrice)}
                </div>
              </div>
            </div>

            {/* Stocked finishes */}
            {stockedFinishes.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <h3 className="text-sm font-semibold text-sh-black">Stocked Finishes</h3>
                  <span className="text-[10px] font-sans font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-green-100 text-green-800">
                    In stock
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {stockedFinishes.map((pf, i) => {
                    const isSelected =
                      selectedFinish &&
                      selectedFinish.material === pf.material &&
                      selectedFinish.isStocked === pf.isStocked;
                    return (
                      <button
                        key={`stocked-${i}`}
                        onClick={() => setSelectedFinish(pf)}
                        className={`text-left rounded-lg border-2 p-4 transition-all ${
                          isSelected
                            ? "border-sh-blue bg-sh-linen shadow-md"
                            : "border-sh-gray/20 bg-white hover:border-sh-blue/40 hover:shadow-sm"
                        }`}
                      >
                        <div className="font-semibold text-sm text-sh-black">{pf.material}</div>
                        {pf.codes.length > 0 && (
                          <div className="text-xs text-sh-gray mt-1">{pf.codes.join(", ")}</div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Special order finishes */}
            {specialOrderFinishes.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <h3 className="text-sm font-semibold text-sh-black">Special Order Finishes</h3>
                  <span className="text-[10px] font-sans font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
                    Special order
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {specialOrderFinishes.map((pf, i) => {
                    const isSelected =
                      selectedFinish &&
                      selectedFinish.material === pf.material &&
                      selectedFinish.isStocked === pf.isStocked;
                    return (
                      <button
                        key={`so-${i}`}
                        onClick={() => setSelectedFinish(pf)}
                        className={`text-left rounded-lg border-2 p-4 transition-all ${
                          isSelected
                            ? "border-sh-blue bg-sh-linen shadow-md"
                            : "border-sh-gray/20 bg-white hover:border-sh-blue/40 hover:shadow-sm"
                        }`}
                      >
                        <div className="font-semibold text-sm text-sh-black">{pf.material}</div>
                        {pf.codes.length > 0 && (
                          <div className="text-xs text-sh-gray mt-1">{pf.codes.join(", ")}</div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Cushion toggle -- only if frame has a linked cushion */}
            {linkedCushion && (
              <div className="bg-white rounded-lg border border-sh-gray/20 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-sh-black">Include Cushion?</h3>
                    <p className="text-xs text-sh-gray mt-0.5">
                      {linkedCushion.cushionCode} -- {linkedCushion.name}
                    </p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={includeCushion}
                    onClick={handleCushionToggle}
                    className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors min-w-[48px] ${
                      includeCushion ? "bg-sh-blue" : "bg-sh-gray/30"
                    }`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform ${
                        includeCushion ? "translate-x-6" : "translate-x-1"
                      }`}
                    />
                  </button>
                </div>
                {includeCushion && (
                  <p className="text-xs text-sh-gray mt-2">
                    Select a fabric grade and fabric on the next steps.
                  </p>
                )}
                {!includeCushion && (
                  <p className="text-xs text-sh-gray mt-2">Frame only -- no cushion pricing.</p>
                )}
              </div>
            )}
          </div>
        )}
      </StepTabPanel>

      {/* ─── Grade Tab ─────────────────────────────────────── */}
      <StepTabPanel tabId="grade">
        {selectedFrame && linkedCushion && (
          <>
            <div className="flex items-center gap-3 mb-4">
              {selectedFrame.imageUrl ? (
                <img
                  src={selectedFrame.imageUrl}
                  alt={selectedFrame.productNumber}
                  className="w-16 h-16 object-contain rounded border border-sh-gray/20 bg-white"
                />
              ) : (
                <Package className="w-5 h-5 text-sh-blue flex-shrink-0" />
              )}
              <div>
                <span className="font-semibold text-sh-black">
                  {selectedFrame.productNumber} -- {selectedFrame.name}
                </span>
                <div className="text-sm text-sh-gray mt-0.5">
                  Frame: {formatCurrency(selectedFrame.framePrice)} + Cushion{" "}
                  {linkedCushion.cushionCode}
                </div>
              </div>
            </div>

            <p className="text-sm text-sh-gray mb-4">
              Select a fabric grade to see the cushion price at that grade.
            </p>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {selectedFrame.gradePrices.map((gp) => {
                if (gp.retail === null) return null;
                const isSelected = selectedTierId === gp.tierId;
                const cushionComponent = gp.retail - selectedFrame.framePrice;
                const totalCost = showCost && costMultiplier ? gp.retail * costMultiplier : null;
                return (
                  <button
                    key={gp.tierId}
                    onClick={() => handleSelectGrade(gp.tierId)}
                    className={`text-left rounded-lg border-2 p-4 transition-all ${
                      isSelected
                        ? "border-sh-blue bg-sh-linen shadow-md"
                        : "border-sh-gray/20 bg-white hover:border-sh-blue/40 hover:shadow-sm"
                    }`}
                  >
                    <div className="font-semibold text-sh-black">Grade {gp.tierCode}</div>
                    <div className="text-sm text-sh-gray mt-1">
                      Cushion: {formatCurrency(cushionComponent)}
                    </div>
                    <div className="text-sm font-semibold text-sh-blue mt-2 tabular-nums">
                      Total: {formatCurrency(gp.retail)}
                    </div>
                    {totalCost != null && (
                      <div className="text-xs text-sh-gray mt-1 tabular-nums">
                        Cost: {formatCurrency(totalCost)}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            {linkedCushion.comYardage != null && (
              <div className="mt-4 text-sm text-sh-gray">
                COM yardage: {linkedCushion.comYardage} yds
              </div>
            )}
          </>
        )}
      </StepTabPanel>

      {/* ─── Fabric Tab ────────────────────────────────────── */}
      <StepTabPanel tabId="fabric">
        {selectedFrame && selectedGradeTier && (
          <>
            <div className="mb-4">
              <span className="font-semibold text-sh-black">{selectedFrame.productNumber}</span>
              <span className="text-sh-gray mx-2">--</span>
              <span className="text-sh-gray">
                {selectedGradeTier.tierCode === "QS"
                  ? "Quick Ship"
                  : `Grade ${selectedGradeTier.tierCode}`}
              </span>
            </div>

            <div className="sticky top-0 z-10 bg-white -mx-4 px-4 pb-3 border-b border-sh-gray/10">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sh-gray" />
                <input
                  type="text"
                  value={fabricSearch}
                  onChange={(e) => setFabricSearch(e.target.value)}
                  placeholder="Search fabrics..."
                  className="w-full border border-sh-gray rounded-lg pl-10 pr-3 py-2 text-sh-black font-serif"
                />
              </div>
            </div>

            {fabricsLoading && (
              <div className="text-center py-8 text-sh-gray">Loading fabrics...</div>
            )}

            {!fabricsLoading && filteredFabrics.length === 0 && fabrics.length === 0 && (
              <div className="text-center py-8 text-sh-gray">
                No fabrics cataloged for this grade. You can skip to Summary.
              </div>
            )}

            {!fabricsLoading && filteredFabrics.length === 0 && fabrics.length > 0 && (
              <div className="text-center py-8 text-sh-gray">No fabrics match your search.</div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-3">
              {filteredFabrics.slice(0, 100).map((f: any, idx: number) => {
                const isSelected = selectedFabric?.id === f.id;
                return (
                  <button
                    key={f.id ?? idx}
                    onClick={() => {
                      setSelectedFabric(f);
                      setActiveTab("summary");
                    }}
                    className={`text-left rounded-lg border px-4 py-3 transition-all ${
                      isSelected
                        ? "border-sh-blue bg-sh-linen shadow-sm"
                        : "border-sh-gray/20 bg-white hover:border-sh-blue/40"
                    }`}
                  >
                    <div className="font-semibold text-sm text-sh-black">{f.fabricName}</div>
                    {f.colorName && <div className="text-xs text-sh-gray">{f.colorName}</div>}
                  </button>
                );
              })}
            </div>
            {filteredFabrics.length > 100 && (
              <div className="text-center py-2 text-sm text-sh-gray">
                Showing 100 of {filteredFabrics.length} -- refine your search.
              </div>
            )}
          </>
        )}
      </StepTabPanel>

      {/* ─── Summary Tab ───────────────────────────────────── */}
      <StepTabPanel tabId="summary">
        {selectedFrame && priceCalc && (
          <div className="max-w-lg mx-auto space-y-6">
            {/* Frame header */}
            <div className="flex items-center gap-4">
              {selectedFrame.imageUrl ? (
                <img
                  src={selectedFrame.imageUrl}
                  alt={selectedFrame.productNumber}
                  className="w-20 h-20 object-contain rounded border border-sh-gray/20 bg-white"
                />
              ) : (
                <div className="w-20 h-20 bg-sh-linen rounded flex items-center justify-center">
                  <Package className="w-8 h-8 text-sh-gray" />
                </div>
              )}
              <div>
                <div className="font-semibold text-lg text-sh-black">
                  {selectedFrame.productNumber}
                </div>
                <div className="text-sh-gray">{selectedFrame.name}</div>
                {selectedFrame.collection && (
                  <div className="text-xs text-sh-gray mt-0.5">{selectedFrame.collection}</div>
                )}
                {(selectedFrame.width || selectedFrame.depth || selectedFrame.height) && (
                  <div className="text-xs text-sh-gray mt-0.5">
                    {[
                      selectedFrame.width && `${selectedFrame.width}"W`,
                      selectedFrame.depth && `${selectedFrame.depth}"D`,
                      selectedFrame.height && `${selectedFrame.height}"H`,
                    ]
                      .filter(Boolean)
                      .join(" x ")}
                  </div>
                )}
              </div>
            </div>

            {/* Price breakdown */}
            <div className="bg-white rounded-lg border border-sh-gray/20 shadow-sm overflow-hidden">
              <table className="w-full text-sm">
                {showCost && (
                  <thead>
                    <tr className="border-b border-sh-gray/10 bg-sh-stripe">
                      <th className="px-4 py-2 text-left text-xs font-semibold text-sh-gray uppercase tracking-wide">
                        Item
                      </th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-sh-gray uppercase tracking-wide">
                        Cost
                      </th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-sh-gray uppercase tracking-wide">
                        Retail
                      </th>
                    </tr>
                  </thead>
                )}
                <tbody>
                  <tr className="border-b border-sh-gray/10">
                    <td className="px-4 py-3 text-sh-gray">Frame</td>
                    {showCost && (
                      <td className="px-4 py-3 text-right tabular-nums text-sh-gray">
                        {priceCalc.frameCost != null
                          ? formatCurrency(priceCalc.frameCost)
                          : "\u2014"}
                      </td>
                    )}
                    <td className="px-4 py-3 text-right tabular-nums font-semibold text-sh-black">
                      {formatCurrency(priceCalc.framePrice)}
                    </td>
                  </tr>
                  {selectedFinish && (
                    <tr className="border-b border-sh-gray/10">
                      <td className="px-4 py-3 text-sh-gray" colSpan={showCost ? 2 : 1}>
                        Finish: {selectedFinish.material}
                        {selectedFinish.codes.length > 0 && (
                          <span className="ml-1 text-xs">({selectedFinish.codes.join(", ")})</span>
                        )}
                        <span
                          className={`ml-2 text-[10px] font-sans font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${
                            selectedFinish.isStocked
                              ? "bg-green-100 text-green-800"
                              : "bg-amber-100 text-amber-800"
                          }`}
                        >
                          {selectedFinish.isStocked ? "Stocked" : "Special order"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-xs text-sh-gray">included</td>
                    </tr>
                  )}
                  {includeCushion && linkedCushion && selectedGradeTier && (
                    <tr className="border-b border-sh-gray/10">
                      <td className="px-4 py-3 text-sh-gray">
                        Cushion {linkedCushion.cushionCode}
                        <span className="ml-1 text-xs">
                          (
                          {selectedGradeTier.tierCode === "QS"
                            ? "Quick Ship"
                            : `Grade ${selectedGradeTier.tierCode}`}
                          )
                        </span>
                      </td>
                      {showCost && (
                        <td className="px-4 py-3 text-right tabular-nums text-sh-gray">
                          {priceCalc.cushionCost != null
                            ? formatCurrency(priceCalc.cushionCost)
                            : "\u2014"}
                        </td>
                      )}
                      <td className="px-4 py-3 text-right tabular-nums font-semibold text-sh-black">
                        {formatCurrency(priceCalc.cushionPrice)}
                      </td>
                    </tr>
                  )}
                  {includeCushion && selectedFabric && (
                    <tr className="border-b border-sh-gray/10">
                      <td className="px-4 py-3 text-sh-gray" colSpan={showCost ? 2 : 1}>
                        Fabric: {selectedFabric.fabricName}
                        {selectedFabric.colorName && ` -- ${selectedFabric.colorName}`}
                      </td>
                      <td className="px-4 py-3 text-right text-xs text-sh-gray">included</td>
                    </tr>
                  )}
                  {!includeCushion && linkedCushion && (
                    <tr className="border-b border-sh-gray/10">
                      <td className="px-4 py-3 text-sh-gray/50" colSpan={showCost ? 2 : 1}>
                        Cushion
                      </td>
                      <td className="px-4 py-3 text-right text-xs text-sh-gray/50">not included</td>
                    </tr>
                  )}
                </tbody>
                <tfoot>
                  {showCost && priceCalc.totalCost != null && (
                    <tr className="border-t border-sh-gray/10">
                      <td className="px-4 py-2 text-sh-gray text-xs">Total Cost</td>
                      <td className="px-4 py-2 text-right tabular-nums text-sh-gray">
                        {formatCurrency(priceCalc.totalCost)}
                      </td>
                      <td />
                    </tr>
                  )}
                  <tr className="bg-sh-linen">
                    <td className="px-4 py-3 font-semibold text-sh-blue">Suggested Retail</td>
                    {showCost && <td />}
                    <td className="px-4 py-3 text-right tabular-nums font-semibold text-sh-blue text-lg">
                      {formatCurrency(priceCalc.totalRetail)}
                    </td>
                  </tr>
                  {showCost && priceCalc.margin != null && priceCalc.marginPercent != null && (
                    <tr>
                      <td className="px-4 py-2 text-sh-gray text-xs">Margin</td>
                      <td />
                      <td className="px-4 py-2 text-right tabular-nums text-xs text-sh-gray">
                        {formatCurrency(priceCalc.margin)} (
                        {(priceCalc.marginPercent * 100).toFixed(1)}%)
                      </td>
                    </tr>
                  )}
                </tfoot>
              </table>
            </div>

            {/* Matching covers */}
            {matchingCovers.length > 0 && (
              <div className="bg-white rounded-lg border border-sh-gray/20 p-4">
                <h4 className="text-sm font-semibold text-sh-blue mb-2">
                  Available Covers ({matchingCovers.length})
                </h4>
                <div className="space-y-2">
                  {matchingCovers.map((cv) => (
                    <div
                      key={cv.id}
                      className="flex items-center justify-between text-sm border-b border-sh-gray/10 pb-2 last:border-0 last:pb-0"
                    >
                      <div>
                        <span className="font-semibold text-sh-black">{cv.coverCode}</span>
                        <span className="text-sh-gray ml-2">{cv.description}</span>
                      </div>
                      <span className="tabular-nums font-semibold text-sh-blue">
                        {cv.retailPrice != null ? formatCurrency(cv.retailPrice) : "\u2014"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {onAddToQuote && (
              <button
                onClick={() => {
                  const descParts: string[] = [];
                  if (selectedFinish) descParts.push(`Finish: ${selectedFinish.material}`);
                  if (includeCushion && selectedGradeTier) {
                    descParts.push(
                      selectedGradeTier.tierCode === "QS"
                        ? "Quick Ship cushion"
                        : `Cushion Grade ${selectedGradeTier.tierCode}`,
                    );
                  }
                  if (includeCushion && selectedFabric) {
                    descParts.push(
                      selectedFabric.fabricName +
                        (selectedFabric.colorName ? ` ${selectedFabric.colorName}` : ""),
                    );
                  }
                  if (!includeCushion && linkedCushion) {
                    descParts.push("Frame only (no cushion)");
                  }
                  onAddToQuote({
                    productId: selectedFrame.id,
                    productNumber: selectedFrame.productNumber,
                    name: selectedFrame.name || selectedFrame.productNumber,
                    description: descParts.join(", "),
                    price: priceCalc.totalRetail,
                    cost: priceCalc.totalCost ?? 0,
                    vendor: vendorName,
                  });
                }}
                className="w-full py-3 rounded-lg bg-sh-gold text-white font-semibold text-base transition hover:bg-sh-gold/90 min-h-[44px]"
              >
                Add to Quote
              </button>
            )}
          </div>
        )}
      </StepTabPanel>
    </StepTabs>
  );
}
