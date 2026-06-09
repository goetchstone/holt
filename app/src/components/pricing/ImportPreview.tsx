// /app/src/components/pricing/ImportPreview.tsx
//
// Preview table for parsed price book data before committing to the database.
// Supports grade-based (Wesley Hall, C R Laine), species-based (Gat Creek),
// and frame+cushion (Kingsley Bate) product formats, auto-detecting layout
// from the product shape.

import { ParsedWholesaleProduct } from "@/lib/pricing/wesleyHallParser";
import type { ParsedGatCreekProduct } from "@/lib/pricing/gatCreekExtractor";
import type {
  ParsedKBFrame,
  ParsedKBCushion,
  ParsedKBCover,
  ParsedKBFabric,
} from "@/lib/pricing/kingsleyBateParser";
import type {
  ParsedBJSeating,
  ParsedBJTable,
  ParsedBJFabric,
  ParsedBJFinish,
} from "@/lib/pricing/brownJordanParser";
import type { ParsedSCProduct, ParsedSCCollection } from "@/lib/pricing/summerClassicsParser";
import type { ParsedJLProduct, ParsedJLCollection } from "@/lib/pricing/jensenLeisureParser";
import type {
  ParsedEkornesProduct,
  ParsedEkornesData,
  ParsedEkornesFabric,
} from "@/lib/pricing/ekornesParser";
import type { ALParsedProduct, ALParsedPage } from "@/lib/pricing/americanLeatherExtractor";

interface FabricRow {
  fabricName: string;
  colorName: string;
  grade: string;
}

interface KBData {
  frames: ParsedKBFrame[];
  cushions: ParsedKBCushion[];
  covers: ParsedKBCover[];
  fabrics: ParsedKBFabric[];
}

interface BJData {
  seating: ParsedBJSeating[];
  tables: ParsedBJTable[];
  fabrics: ParsedBJFabric[];
  finishes?: ParsedBJFinish[];
}

interface SCData {
  products: ParsedSCProduct[];
  collections: ParsedSCCollection[];
}

interface JLData {
  products: ParsedJLProduct[];
  collections: ParsedJLCollection[];
}

interface EkornesData {
  products: ParsedEkornesProduct[];
  collections: string[];
  gradeTiers: string[];
  fabrics: ParsedEkornesFabric[];
}

interface ALData {
  products: ALParsedProduct[];
  pages?: ALParsedPage[];
  collections: string[];
  effectiveDate: string | null;
  isRetail: boolean;
}

interface Props {
  products: (ParsedWholesaleProduct | ParsedGatCreekProduct | FabricRow | any)[];
  importType?: string;
  kbData?: KBData | BJData | null;
}

/** Type guard: is this a Kingsley Bate frame? */
function isKBFrame(p: any): p is ParsedKBFrame {
  return typeof p.framePrice === "number" && typeof p.collection === "string";
}

/** Type guard: is the kbData prop BJ-shaped? */
function isBJData(data: any): data is BJData {
  return Array.isArray(data?.seating);
}

/** Type guard: is the kbData prop SC-shaped? */
function isSCData(data: any): data is SCData {
  return Array.isArray(data?.products) && Array.isArray(data?.collections);
}

/** Type guard: is the kbData prop JL-shaped? Distinguishes from SC by itemNumber field. */
function isJLData(data: any): data is JLData {
  return (
    Array.isArray(data?.products) &&
    Array.isArray(data?.collections) &&
    data.products.length > 0 &&
    typeof data.products[0].itemNumber === "string"
  );
}

/** Type guard: is the kbData prop Ekornes-shaped? */
function isEkornesData(data: any): data is EkornesData {
  return (
    Array.isArray(data?.products) &&
    Array.isArray(data?.gradeTiers) &&
    data.products.length > 0 &&
    typeof data.products[0].materialNumber === "string"
  );
}

/** Type guard: is the kbData prop AL-shaped? Distinguishes from SC by isRetail field. */
function isALData(data: any): data is ALData {
  return (
    Array.isArray(data?.products) &&
    Array.isArray(data?.collections) &&
    typeof data?.isRetail === "boolean"
  );
}

/** Type guard: is this a Gat Creek / species-based product? */
function isGatCreekProduct(p: any): p is ParsedGatCreekProduct {
  return p.pricingType === "SPECIES" || p.pricingType === "MATRIX" || p.pricingType === "ROUND";
}

/** Type guard: is this a fabric catalog row? */
function isFabricRow(p: any): p is FabricRow {
  return typeof p.fabricName === "string" && typeof p.grade === "string";
}

export default function ImportPreview({ products, importType, kbData }: Props) {
  if (products.length === 0) {
    return (
      <div className="text-center py-8 text-sh-gray">
        No products parsed. Try a different file or check the format.
      </div>
    );
  }

  // Detect format from the first product or the import type
  const firstProduct = products[0];

  if (importType === "fabrics" || isFabricRow(firstProduct)) {
    return <FabricPreview fabrics={products as FabricRow[]} />;
  }

  if (kbData && isEkornesData(kbData)) {
    return <EkornesPreview ekData={kbData} />;
  }

  if (kbData && isJLData(kbData)) {
    return <JLPreview jlData={kbData} />;
  }

  if (kbData && isALData(kbData)) {
    return <ALPreview alData={kbData} />;
  }

  if (kbData && isSCData(kbData)) {
    return <SCPreview scData={kbData} />;
  }

  if (kbData && isBJData(kbData)) {
    return <BJPreview bjData={kbData} />;
  }

  if (kbData || isKBFrame(firstProduct)) {
    return (
      <KBPreview
        kbData={
          (kbData as KBData) || {
            frames: products as ParsedKBFrame[],
            cushions: [],
            covers: [],
            fabrics: [],
          }
        }
      />
    );
  }

  if (isGatCreekProduct(firstProduct)) {
    return <GatCreekPreview products={products as ParsedGatCreekProduct[]} />;
  }

  // Default: grade-based preview
  return <GradePreview products={products as ParsedWholesaleProduct[]} />;
}

// ─── Grade-based preview (Wesley Hall, C R Laine) ────────────────

function GradePreview({ products }: { products: ParsedWholesaleProduct[] }) {
  // Check if any products have dimension data
  const hasDimensions = products.some((p) => p.overallWidth || p.overallDepth || p.overallHeight);

  const formatDims = (p: ParsedWholesaleProduct) => {
    if (!p.overallWidth && !p.overallDepth && !p.overallHeight) return "—";
    const parts: string[] = [];
    if (p.overallWidth) parts.push(`${p.overallWidth}"W`);
    if (p.overallDepth) parts.push(`${p.overallDepth}"D`);
    if (p.overallHeight) parts.push(`${p.overallHeight}"H`);
    return parts.join(" x ");
  };

  // Collect all unique grades across products, sorted
  const allGrades = new Set<string>();
  for (const p of products) {
    for (const gp of p.gradePrices) {
      allGrades.add(gp.grade);
    }
  }
  const sortedGrades = Array.from(allGrades).sort((a, b) => {
    if (a === "COM" || a === "COL") return -1;
    if (b === "COM" || b === "COL") return 1;
    const aNum = Number.parseInt(a);
    const bNum = Number.parseInt(b);
    if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) return aNum - bNum;
    if (!Number.isNaN(aNum)) return -1;
    if (!Number.isNaN(bNum)) return 1;
    return a.localeCompare(b);
  });

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex gap-4">
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{products.length}</span> products
        </div>
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{sortedGrades.length}</span> grade tiers
        </div>
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">
            {products.reduce((sum, p) => sum + p.gradePrices.length, 0)}
          </span>{" "}
          price points
        </div>
        {hasDimensions && (
          <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
            <span className="font-semibold text-sh-blue">
              {products.filter((p) => p.overallWidth || p.overallDepth || p.overallHeight).length}
            </span>{" "}
            with dimensions
          </div>
        )}
      </div>

      {/* Preview table */}
      <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="bg-sh-linen">
                <th className="px-3 py-2 border-b border-sh-gray sticky left-0 bg-sh-linen z-10 min-w-[80px]">
                  Style #
                </th>
                <th className="px-3 py-2 border-b border-sh-gray min-w-[120px]">Description</th>
                <th className="px-3 py-2 border-b border-sh-gray min-w-[120px]">Name</th>
                {sortedGrades.map((g) => (
                  <th key={g} className="px-3 py-2 border-b border-sh-gray text-right min-w-[80px]">
                    {g === "COM" ? "COM" : g === "COL" ? "COL" : `Gr ${g}`}
                  </th>
                ))}
                <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[60px]">Riser</th>
                <th className="px-3 py-2 border-b border-sh-gray min-w-[100px]">Seat</th>
                {hasDimensions && (
                  <th className="px-3 py-2 border-b border-sh-gray min-w-[140px]">Dimensions</th>
                )}
              </tr>
            </thead>
            <tbody>
              {products.slice(0, 50).map((p, idx) => {
                const gradeMap = new Map(p.gradePrices.map((gp) => [gp.grade, gp.cost]));
                return (
                  <tr key={idx} className="odd:bg-white even:bg-sh-stripe hover:bg-sh-gray/10">
                    <td className="px-3 py-2 border-b border-sh-gray font-semibold sticky left-0 bg-inherit z-10">
                      {p.styleNumber}
                    </td>
                    <td className="px-3 py-2 border-b border-sh-gray">{p.description}</td>
                    <td className="px-3 py-2 border-b border-sh-gray">{p.styleName}</td>
                    {sortedGrades.map((g) => (
                      <td
                        key={g}
                        className="px-3 py-2 border-b border-sh-gray text-right tabular-nums"
                      >
                        {gradeMap.has(g) ? formatCurrency(gradeMap.get(g)!) : "—"}
                      </td>
                    ))}
                    <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums">
                      {p.gradeRiser ? `$${p.gradeRiser}` : "—"}
                    </td>
                    <td className="px-3 py-2 border-b border-sh-gray text-xs">
                      {p.standardSeat || "—"}
                    </td>
                    {hasDimensions && (
                      <td className="px-3 py-2 border-b border-sh-gray text-xs tabular-nums">
                        {formatDims(p)}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {products.length > 50 && (
          <div className="px-3 py-2 text-sm text-sh-gray bg-sh-linen text-center">
            Showing first 50 of {products.length} products
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Fabric catalog preview ──────────────────────────────────────

function FabricPreview({ fabrics }: { fabrics: FabricRow[] }) {
  // Collect unique grades for summary
  const uniqueGrades = new Set(fabrics.map((f) => f.grade));

  // Sort by pattern name, then color
  const sorted = [...fabrics].sort((a, b) => {
    const cmp = a.fabricName.localeCompare(b.fabricName);
    return cmp !== 0 ? cmp : a.colorName.localeCompare(b.colorName);
  });

  // Group by grade for summary breakdown
  const gradeCountMap = new Map<string, number>();
  for (const f of fabrics) {
    gradeCountMap.set(f.grade, (gradeCountMap.get(f.grade) || 0) + 1);
  }
  const gradeSummary = Array.from(gradeCountMap.entries()).sort((a, b) => {
    const aNum = Number.parseInt(a[0]);
    const bNum = Number.parseInt(b[0]);
    if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) return aNum - bNum;
    if (!Number.isNaN(aNum)) return -1;
    if (!Number.isNaN(bNum)) return 1;
    return a[0].localeCompare(b[0]);
  });

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex flex-wrap gap-4">
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{fabrics.length}</span> unique fabrics
        </div>
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{uniqueGrades.size}</span> grades
        </div>
      </div>

      {/* Grade breakdown */}
      <div className="flex flex-wrap gap-2">
        {gradeSummary.map(([grade, count]) => (
          <span
            key={grade}
            className="inline-flex items-center gap-1 bg-white border border-sh-gray/30 rounded-full px-3 py-1 text-xs"
          >
            <span className="font-semibold text-sh-blue">
              {/^[A-Z]$/i.test(grade) ? `Leather ${grade}` : `Grade ${grade}`}
            </span>
            <span className="text-sh-gray">({count})</span>
          </span>
        ))}
      </div>

      {/* Preview table */}
      <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="bg-sh-linen">
                <th className="px-3 py-2 border-b border-sh-gray min-w-[200px]">Fabric Pattern</th>
                <th className="px-3 py-2 border-b border-sh-gray min-w-[150px]">Color</th>
                <th className="px-3 py-2 border-b border-sh-gray text-center min-w-[80px]">
                  Grade
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.slice(0, 100).map((f, idx) => (
                <tr key={idx} className="odd:bg-white even:bg-sh-stripe hover:bg-sh-gray/10">
                  <td className="px-3 py-2 border-b border-sh-gray font-semibold">
                    {f.fabricName}
                  </td>
                  <td className="px-3 py-2 border-b border-sh-gray">{f.colorName || "—"}</td>
                  <td className="px-3 py-2 border-b border-sh-gray text-center">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${
                        /^[A-Z]$/i.test(f.grade)
                          ? "bg-amber-100 text-amber-700"
                          : "bg-blue-100 text-blue-700"
                      }`}
                    >
                      {f.grade}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {sorted.length > 100 && (
          <div className="px-3 py-2 text-sm text-sh-gray bg-sh-linen text-center">
            Showing first 100 of {sorted.length} fabrics
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Gat Creek / species-based preview ───────────────────────────

function GatCreekPreview({ products }: { products: ParsedGatCreekProduct[] }) {
  const speciesProducts = products.filter((p) => p.pricingType === "SPECIES");
  const matrixProducts = products.filter((p) => p.pricingType === "MATRIX");
  const roundProducts = products.filter((p) => p.pricingType === "ROUND");

  // Count total price points
  const speciesPricePoints = speciesProducts.reduce((sum, p) => {
    if (!p.speciesPrices) return sum;
    return (
      sum +
      [
        p.speciesPrices.ash,
        p.speciesPrices.cherry,
        p.speciesPrices.maple,
        p.speciesPrices.walnut,
        p.speciesPrices.paint,
      ].filter((v) => v !== null).length
    );
  }, 0);
  const matrixPricePoints = matrixProducts.reduce(
    (sum, p) => sum + (p.matrixPrices?.length || 0),
    0,
  );
  const roundPricePoints = roundProducts.reduce((sum, p) => sum + (p.roundPrices?.length || 0), 0);

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="flex flex-wrap gap-4">
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{products.length}</span> products
        </div>
        {speciesProducts.length > 0 && (
          <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
            <span className="font-semibold text-sh-blue">{speciesProducts.length}</span> line items
          </div>
        )}
        {matrixProducts.length > 0 && (
          <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
            <span className="font-semibold text-sh-blue">{matrixProducts.length}</span> custom
            tables
          </div>
        )}
        {roundProducts.length > 0 && (
          <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
            <span className="font-semibold text-sh-blue">{roundProducts.length}</span> round tables
          </div>
        )}
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">
            {speciesPricePoints + matrixPricePoints + roundPricePoints}
          </span>{" "}
          price points
        </div>
      </div>

      {/* Species products table */}
      {speciesProducts.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-sh-blue mb-2">
            Line Items ({speciesProducts.length})
          </h3>
          <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="bg-sh-linen">
                    <th className="px-3 py-2 border-b border-sh-gray sticky left-0 bg-sh-linen z-10 min-w-[70px]">
                      SKU
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[180px]">Description</th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[80px]">Size</th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[80px]">
                      Ash
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[80px]">
                      Cherry
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[80px]">
                      Maple
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[80px]">
                      Walnut
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[80px]">
                      Paint
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {speciesProducts.slice(0, 50).map((p, idx) => (
                    <tr key={idx} className="odd:bg-white even:bg-sh-stripe hover:bg-sh-gray/10">
                      <td className="px-3 py-2 border-b border-sh-gray font-semibold sticky left-0 bg-inherit z-10">
                        {p.itemNumber}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray">{p.description}</td>
                      <td className="px-3 py-2 border-b border-sh-gray text-xs">{p.size || "—"}</td>
                      <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums">
                        {p.speciesPrices?.ash != null ? formatCurrency(p.speciesPrices.ash) : "—"}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums">
                        {p.speciesPrices?.cherry != null
                          ? formatCurrency(p.speciesPrices.cherry)
                          : "—"}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums">
                        {p.speciesPrices?.maple != null
                          ? formatCurrency(p.speciesPrices.maple)
                          : "—"}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums">
                        {p.speciesPrices?.walnut != null
                          ? formatCurrency(p.speciesPrices.walnut)
                          : "—"}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums">
                        {p.speciesPrices?.paint != null
                          ? formatCurrency(p.speciesPrices.paint)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {speciesProducts.length > 50 && (
              <div className="px-3 py-2 text-sm text-sh-gray bg-sh-linen text-center">
                Showing first 50 of {speciesProducts.length} line items
              </div>
            )}
          </div>
        </div>
      )}

      {/* Matrix (custom table) products */}
      {matrixProducts.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-sh-blue mb-2">
            Custom Shop Tables ({matrixProducts.length})
          </h3>
          <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="bg-sh-linen">
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[80px]">Style</th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[160px]">Variant</th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[80px]">
                      Sizes
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[80px]">
                      Price Pts
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[100px]">
                      Price Range
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[100px]">Leaf Info</th>
                  </tr>
                </thead>
                <tbody>
                  {matrixProducts.map((p, idx) => {
                    const prices = p.matrixPrices?.map((m) => m.cost) || [];
                    const min = prices.length > 0 ? Math.min(...prices) : 0;
                    const max = prices.length > 0 ? Math.max(...prices) : 0;
                    const uniqueSizes = new Set(
                      p.matrixPrices?.map((m) => `${m.width}×${m.length}`) || [],
                    );
                    return (
                      <tr key={idx} className="odd:bg-white even:bg-sh-stripe hover:bg-sh-gray/10">
                        <td className="px-3 py-2 border-b border-sh-gray font-semibold">
                          {p.tableStyle}
                        </td>
                        <td className="px-3 py-2 border-b border-sh-gray text-xs">
                          {p.tableVariant}
                        </td>
                        <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums">
                          {uniqueSizes.size}
                        </td>
                        <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums">
                          {prices.length}
                        </td>
                        <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums text-xs">
                          {formatCurrency(min)} – {formatCurrency(max)}
                        </td>
                        <td className="px-3 py-2 border-b border-sh-gray text-xs">
                          {p.leafInfo || "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Round table products */}
      {roundProducts.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-sh-blue mb-2">
            Round Tables ({roundProducts.length})
          </h3>
          <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="bg-sh-linen">
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[80px]">Style</th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[160px]">Variant</th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[80px]">
                      Diameters
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[80px]">
                      Price Pts
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[100px]">
                      Price Range
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {roundProducts.map((p, idx) => {
                    const prices = p.roundPrices?.map((r) => r.cost) || [];
                    const min = prices.length > 0 ? Math.min(...prices) : 0;
                    const max = prices.length > 0 ? Math.max(...prices) : 0;
                    const diameters = new Set(p.roundPrices?.map((r) => r.diameter) || []);
                    return (
                      <tr key={idx} className="odd:bg-white even:bg-sh-stripe hover:bg-sh-gray/10">
                        <td className="px-3 py-2 border-b border-sh-gray font-semibold">
                          {p.tableStyle}
                        </td>
                        <td className="px-3 py-2 border-b border-sh-gray text-xs">
                          {p.tableVariant}
                        </td>
                        <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums">
                          {Array.from(diameters)
                            .sort((a, b) => a - b)
                            .map((d) => `${d}"`)
                            .join(", ")}
                        </td>
                        <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums">
                          {prices.length}
                        </td>
                        <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums text-xs">
                          {formatCurrency(min)} – {formatCurrency(max)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Kingsley Bate frame+cushion preview ─────────────────────────

function KBPreview({ kbData }: { kbData: KBData }) {
  const { frames, cushions, covers, fabrics } = kbData;
  const currentCushions = cushions.filter((c) => !c.isDiscontinued);
  const discCushions = cushions.filter((c) => c.isDiscontinued);

  const formatDims = (f: ParsedKBFrame) => {
    if (!f.width && !f.depth && !f.height) return "\u2014";
    const parts: string[] = [];
    if (f.width) parts.push(`${f.width}"W`);
    if (f.depth) parts.push(`${f.depth}"D`);
    if (f.height) parts.push(`${f.height}"H`);
    return parts.join(" x ");
  };

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="flex flex-wrap gap-4">
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{frames.length}</span> frames
        </div>
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{currentCushions.length}</span> cushions
          {discCushions.length > 0 && (
            <span className="text-sh-gray ml-1">(+{discCushions.length} disc.)</span>
          )}
        </div>
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{covers.length}</span> covers
        </div>
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{fabrics.length}</span> fabrics
        </div>
      </div>

      {/* Frames */}
      {frames.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-sh-blue mb-2">Frames ({frames.length})</h3>
          <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="bg-sh-linen">
                    <th className="px-3 py-2 border-b border-sh-gray sticky left-0 bg-sh-linen z-10 min-w-[80px]">
                      Style #
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[140px]">Description</th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[100px]">Collection</th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[80px]">
                      Frame
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[60px]">A</th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[60px]">B</th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[60px]">C</th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[60px]">D</th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[60px]">Cushion</th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[100px]">Dims</th>
                  </tr>
                </thead>
                <tbody>
                  {frames.slice(0, 50).map((f, idx) => (
                    <tr key={idx} className="odd:bg-white even:bg-sh-stripe hover:bg-sh-gray/10">
                      <td className="px-3 py-2 border-b border-sh-gray font-semibold sticky left-0 bg-inherit z-10">
                        {f.styleNumber}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray">{f.description}</td>
                      <td className="px-3 py-2 border-b border-sh-gray text-xs">{f.collection}</td>
                      <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums">
                        {formatCurrency(f.framePrice)}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums">
                        {f.combinedPrices.a != null ? formatCurrency(f.combinedPrices.a) : "\u2014"}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums">
                        {f.combinedPrices.b != null ? formatCurrency(f.combinedPrices.b) : "\u2014"}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums">
                        {f.combinedPrices.c != null ? formatCurrency(f.combinedPrices.c) : "\u2014"}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums">
                        {f.combinedPrices.d != null ? formatCurrency(f.combinedPrices.d) : "\u2014"}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray text-xs">
                        {f.cushionRef || "\u2014"}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray text-xs tabular-nums">
                        {formatDims(f)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {frames.length > 50 && (
              <div className="px-3 py-2 text-sm text-sh-gray bg-sh-linen text-center">
                Showing first 50 of {frames.length} frames
              </div>
            )}
          </div>
        </div>
      )}

      {/* Cushions */}
      {cushions.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-sh-blue mb-2">
            Cushions ({currentCushions.length}
            {discCushions.length > 0 && ` + ${discCushions.length} discontinued`})
          </h3>
          <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="bg-sh-linen">
                    <th className="px-3 py-2 border-b border-sh-gray sticky left-0 bg-sh-linen z-10 min-w-[70px]">
                      Code
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[140px]">Description</th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[80px]">Fits</th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[60px]">
                      QS
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[60px]">A</th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[60px]">B</th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[60px]">C</th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[60px]">D</th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[50px]">
                      COM
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {cushions.slice(0, 50).map((c, idx) => (
                    <tr
                      key={idx}
                      className={`hover:bg-sh-gray/10 ${c.isDiscontinued ? "text-sh-gray/60" : "odd:bg-white even:bg-sh-stripe"}`}
                    >
                      <td className="px-3 py-2 border-b border-sh-gray font-semibold sticky left-0 bg-inherit z-10">
                        {c.cushionCode}
                        {c.isDiscontinued && (
                          <span className="ml-1 text-xs font-normal text-amber-600">disc.</span>
                        )}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray">{c.description}</td>
                      <td className="px-3 py-2 border-b border-sh-gray text-xs">
                        {c.fitsFrames.join(", ") || "\u2014"}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums">
                        {c.prices.qs != null ? formatCurrency(c.prices.qs) : "\u2014"}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums">
                        {c.prices.a != null ? formatCurrency(c.prices.a) : "\u2014"}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums">
                        {c.prices.b != null ? formatCurrency(c.prices.b) : "\u2014"}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums">
                        {c.prices.c != null ? formatCurrency(c.prices.c) : "\u2014"}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums">
                        {c.prices.d != null ? formatCurrency(c.prices.d) : "\u2014"}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums">
                        {c.comYardage != null ? c.comYardage : "\u2014"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {cushions.length > 50 && (
              <div className="px-3 py-2 text-sm text-sh-gray bg-sh-linen text-center">
                Showing first 50 of {cushions.length} cushions
              </div>
            )}
          </div>
        </div>
      )}

      {/* Covers */}
      {covers.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-sh-blue mb-2">Covers ({covers.length})</h3>
          <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="bg-sh-linen">
                    <th className="px-3 py-2 border-b border-sh-gray sticky left-0 bg-sh-linen z-10 min-w-[70px]">
                      Code
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[180px]">Description</th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[80px]">Fits Frame</th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[80px]">
                      Price
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {covers.slice(0, 50).map((cv, idx) => (
                    <tr key={idx} className="odd:bg-white even:bg-sh-stripe hover:bg-sh-gray/10">
                      <td className="px-3 py-2 border-b border-sh-gray font-semibold sticky left-0 bg-inherit z-10">
                        {cv.coverCode}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray">{cv.description}</td>
                      <td className="px-3 py-2 border-b border-sh-gray text-xs">{cv.fitsFrame}</td>
                      <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums">
                        {formatCurrency(cv.retailPrice)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {covers.length > 50 && (
              <div className="px-3 py-2 text-sm text-sh-gray bg-sh-linen text-center">
                Showing first 50 of {covers.length} covers
              </div>
            )}
          </div>
        </div>
      )}

      {/* Fabrics */}
      {fabrics.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-sh-blue mb-2">Fabrics ({fabrics.length})</h3>
          <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="bg-sh-linen">
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[180px]">Name</th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[80px]">Code</th>
                    <th className="px-3 py-2 border-b border-sh-gray text-center min-w-[60px]">
                      Grade
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[80px]">Welt</th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[60px]">Restriction</th>
                  </tr>
                </thead>
                <tbody>
                  {fabrics.slice(0, 50).map((fb, idx) => (
                    <tr key={idx} className="odd:bg-white even:bg-sh-stripe hover:bg-sh-gray/10">
                      <td className="px-3 py-2 border-b border-sh-gray font-semibold">{fb.name}</td>
                      <td className="px-3 py-2 border-b border-sh-gray">{fb.code}</td>
                      <td className="px-3 py-2 border-b border-sh-gray text-center">
                        <span className="inline-block px-2 py-0.5 rounded text-xs font-semibold bg-blue-100 text-blue-700">
                          {fb.grade}
                        </span>
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray text-xs">{fb.weltType}</td>
                      <td className="px-3 py-2 border-b border-sh-gray text-xs">
                        {fb.restrictionCode || "\u2014"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {fabrics.length > 50 && (
              <div className="px-3 py-2 text-sm text-sh-gray bg-sh-linen text-center">
                Showing first 50 of {fabrics.length} fabrics
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Brown Jordan preview ────────────────────────────────────────

function BJPreview({ bjData }: { bjData: BJData }) {
  const { seating, tables, fabrics, finishes = [] } = bjData;

  // Collect all unique grades across seating products
  const allGrades = new Set<string>();
  for (const s of seating) {
    for (const gp of s.gradePrices) {
      allGrades.add(gp.grade);
    }
  }
  const sortedGrades = Array.from(allGrades).sort((a, b) => a.localeCompare(b));

  // Unique collections
  const collections = new Set<string>();
  for (const s of seating) collections.add(s.collection);
  for (const t of tables) collections.add(t.collection);

  // Grade counts for fabric summary
  const fabricGradeMap = new Map<string, number>();
  for (const f of fabrics) {
    fabricGradeMap.set(f.grade, (fabricGradeMap.get(f.grade) || 0) + 1);
  }

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="flex flex-wrap gap-4">
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{seating.length}</span> seating
        </div>
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{tables.length}</span> tables
        </div>
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{fabrics.length}</span> fabrics
        </div>
        {finishes.length > 0 && (
          <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
            <span className="font-semibold text-sh-blue">{finishes.length}</span> finishes
          </div>
        )}
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{collections.size}</span> collections
        </div>
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{sortedGrades.length}</span> grade tiers
        </div>
      </div>

      {/* Seating */}
      {seating.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-sh-blue mb-2">Seating ({seating.length})</h3>
          <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="bg-sh-linen">
                    <th className="px-3 py-2 border-b border-sh-gray sticky left-0 bg-sh-linen z-10 min-w-[90px]">
                      Style #
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[140px]">Description</th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[100px]">Collection</th>
                    {sortedGrades.map((g) => (
                      <th
                        key={g}
                        className="px-3 py-2 border-b border-sh-gray text-right min-w-[70px]"
                      >
                        {g}
                      </th>
                    ))}
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[70px]">
                      COM
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {seating.slice(0, 50).map((s, idx) => {
                    const gradeMap = new Map(s.gradePrices.map((gp) => [gp.grade, gp.retail]));
                    return (
                      <tr key={idx} className="odd:bg-white even:bg-sh-stripe hover:bg-sh-gray/10">
                        <td className="px-3 py-2 border-b border-sh-gray font-semibold sticky left-0 bg-inherit z-10">
                          {s.styleNumber}
                        </td>
                        <td className="px-3 py-2 border-b border-sh-gray">{s.description}</td>
                        <td className="px-3 py-2 border-b border-sh-gray text-xs">
                          {s.collection}
                        </td>
                        {sortedGrades.map((g) => (
                          <td
                            key={g}
                            className="px-3 py-2 border-b border-sh-gray text-right tabular-nums"
                          >
                            {gradeMap.has(g) ? formatCurrency(gradeMap.get(g)!) : "\u2014"}
                          </td>
                        ))}
                        <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums">
                          {s.comRetail != null ? formatCurrency(s.comRetail) : "\u2014"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {seating.length > 50 && (
              <div className="px-3 py-2 text-sm text-sh-gray bg-sh-linen text-center">
                Showing first 50 of {seating.length} seating items
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tables */}
      {tables.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-sh-blue mb-2">Tables ({tables.length})</h3>
          <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="bg-sh-linen">
                    <th className="px-3 py-2 border-b border-sh-gray sticky left-0 bg-sh-linen z-10 min-w-[90px]">
                      Style #
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[140px]">Description</th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[100px]">Collection</th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[80px]">
                      MSRP
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[60px]">Top</th>
                  </tr>
                </thead>
                <tbody>
                  {tables.slice(0, 50).map((t, idx) => (
                    <tr key={idx} className="odd:bg-white even:bg-sh-stripe hover:bg-sh-gray/10">
                      <td className="px-3 py-2 border-b border-sh-gray font-semibold sticky left-0 bg-inherit z-10">
                        {t.styleNumber}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray">{t.description}</td>
                      <td className="px-3 py-2 border-b border-sh-gray text-xs">{t.collection}</td>
                      <td className="px-3 py-2 border-b border-sh-gray text-right tabular-nums">
                        {formatCurrency(t.msrp)}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray text-xs">
                        {t.tableTop || "\u2014"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {tables.length > 50 && (
              <div className="px-3 py-2 text-sm text-sh-gray bg-sh-linen text-center">
                Showing first 50 of {tables.length} tables
              </div>
            )}
          </div>
        </div>
      )}

      {/* Fabrics */}
      {fabrics.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-sh-blue mb-2">Fabrics ({fabrics.length})</h3>
          <div className="flex flex-wrap gap-2 mb-3">
            {Array.from(fabricGradeMap.entries())
              .sort((a, b) => a[0].localeCompare(b[0]))
              .map(([grade, count]) => (
                <span
                  key={grade}
                  className="inline-flex items-center gap-1 bg-white border border-sh-gray/30 rounded-full px-3 py-1 text-xs"
                >
                  <span className="font-semibold text-sh-blue">Grade {grade}</span>
                  <span className="text-sh-gray">({count})</span>
                </span>
              ))}
          </div>
          <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="bg-sh-linen">
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[70px]">Fabric #</th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[150px]">Name</th>
                    <th className="px-3 py-2 border-b border-sh-gray text-center min-w-[60px]">
                      Grade
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[120px]">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {fabrics.slice(0, 50).map((f, idx) => (
                    <tr key={idx} className="odd:bg-white even:bg-sh-stripe hover:bg-sh-gray/10">
                      <td className="px-3 py-2 border-b border-sh-gray font-semibold">
                        {f.fabricNumber}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray">{f.fabricName}</td>
                      <td className="px-3 py-2 border-b border-sh-gray text-center">
                        <span className="inline-block px-2 py-0.5 rounded text-xs font-semibold bg-blue-100 text-blue-700">
                          {f.grade}
                        </span>
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray text-xs">{f.fabricType}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {fabrics.length > 50 && (
              <div className="px-3 py-2 text-sm text-sh-gray bg-sh-linen text-center">
                Showing first 50 of {fabrics.length} fabrics
              </div>
            )}
          </div>
        </div>
      )}

      {/* Finishes */}
      {finishes.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-sh-blue mb-2">Finishes ({finishes.length})</h3>
          <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="bg-sh-linen">
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[80px]">Code</th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[200px]">Name</th>
                  </tr>
                </thead>
                <tbody>
                  {finishes.map((f, idx) => (
                    <tr key={idx} className="odd:bg-white even:bg-sh-stripe hover:bg-sh-gray/10">
                      <td className="px-3 py-2 border-b border-sh-gray font-semibold">
                        {f.finishCode || "\u2014"}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray">{f.finishName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Jensen Leisure preview ─────────────────────────────────────

function JLPreview({ jlData }: { jlData: JLData }) {
  const { products, collections } = jlData;

  const cushionedProducts = products.filter((p) => !p.isFrameOnly && !p.isCushionOnly);
  const frameOnlyProducts = products.filter((p) => p.isFrameOnly);
  const cushionOnlyProducts = products.filter((p) => p.isCushionOnly);
  const GRADES = ["C", "D", "E", "U"];

  return (
    <div className="space-y-6">
      {/* Summary badges */}
      <div className="flex flex-wrap gap-4">
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{products.length}</span> products
        </div>
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{cushionedProducts.length}</span> cushioned
        </div>
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{frameOnlyProducts.length}</span> frame-only
        </div>
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{cushionOnlyProducts.length}</span>{" "}
          cushion-only
        </div>
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{collections.length}</span> collections
        </div>
      </div>

      {/* Collections */}
      {collections.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-sh-blue mb-2">
            Collections ({collections.length})
          </h3>
          <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="bg-sh-linen">
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[150px]">Collection</th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[200px]">
                      Material Type
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {collections.map((c, idx) => (
                    <tr key={idx} className="odd:bg-white even:bg-sh-stripe hover:bg-sh-gray/10">
                      <td className="px-3 py-2 border-b border-sh-gray font-semibold">{c.name}</td>
                      <td className="px-3 py-2 border-b border-sh-gray text-xs">
                        {c.materialType || "\u2014"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Cushioned products */}
      {cushionedProducts.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-sh-blue mb-2">
            Cushioned Products ({cushionedProducts.length})
          </h3>
          <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="bg-sh-linen">
                    <th className="px-3 py-2 border-b border-sh-gray sticky left-0 bg-sh-linen z-10 min-w-[80px]">
                      Item #
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[200px]">Description</th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[120px]">Collection</th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[80px]">
                      Frame
                    </th>
                    {GRADES.map((g) => (
                      <th
                        key={g}
                        className="px-3 py-2 border-b border-sh-gray text-right min-w-[70px]"
                      >
                        {g}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cushionedProducts.slice(0, 100).map((p, idx) => (
                    <tr key={idx} className="odd:bg-white even:bg-sh-stripe hover:bg-sh-gray/10">
                      <td className="px-3 py-2 border-b border-sh-gray sticky left-0 bg-inherit font-semibold">
                        {p.itemNumber}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray">{p.description}</td>
                      <td className="px-3 py-2 border-b border-sh-gray text-xs">{p.collection}</td>
                      <td className="px-3 py-2 border-b border-sh-gray text-right">
                        {p.framePrice ? formatCurrency(p.framePrice) : "\u2014"}
                      </td>
                      {GRADES.map((g) => {
                        const gp = p.gradePrices.find((gp) => gp.grade === g);
                        return (
                          <td key={g} className="px-3 py-2 border-b border-sh-gray text-right">
                            {gp ? formatCurrency(gp.retail) : "\u2014"}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {cushionedProducts.length > 100 && (
              <div className="px-3 py-2 text-sm text-sh-gray bg-sh-linen text-center">
                Showing first 100 of {cushionedProducts.length} cushioned products
              </div>
            )}
          </div>
        </div>
      )}

      {/* Frame-only products */}
      {frameOnlyProducts.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-sh-blue mb-2">
            Frame-Only Products ({frameOnlyProducts.length})
          </h3>
          <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="bg-sh-linen">
                    <th className="px-3 py-2 border-b border-sh-gray sticky left-0 bg-sh-linen z-10 min-w-[80px]">
                      Item #
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[250px]">Description</th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[120px]">Collection</th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[80px]">
                      Retail
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {frameOnlyProducts.slice(0, 100).map((p, idx) => (
                    <tr key={idx} className="odd:bg-white even:bg-sh-stripe hover:bg-sh-gray/10">
                      <td className="px-3 py-2 border-b border-sh-gray sticky left-0 bg-inherit font-semibold">
                        {p.itemNumber}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray">{p.description}</td>
                      <td className="px-3 py-2 border-b border-sh-gray text-xs">{p.collection}</td>
                      <td className="px-3 py-2 border-b border-sh-gray text-right">
                        {p.framePrice ? formatCurrency(p.framePrice) : "\u2014"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {frameOnlyProducts.length > 100 && (
              <div className="px-3 py-2 text-sm text-sh-gray bg-sh-linen text-center">
                Showing first 100 of {frameOnlyProducts.length} frame-only products
              </div>
            )}
          </div>
        </div>
      )}

      {/* Cushion-only products */}
      {cushionOnlyProducts.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-sh-blue mb-2">
            Cushion-Only Products ({cushionOnlyProducts.length})
          </h3>
          <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="bg-sh-linen">
                    <th className="px-3 py-2 border-b border-sh-gray sticky left-0 bg-sh-linen z-10 min-w-[80px]">
                      Item #
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[200px]">Description</th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[120px]">Collection</th>
                    {GRADES.map((g) => (
                      <th
                        key={g}
                        className="px-3 py-2 border-b border-sh-gray text-right min-w-[70px]"
                      >
                        {g}
                      </th>
                    ))}
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[70px]">
                      COM Yds
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {cushionOnlyProducts.slice(0, 100).map((p, idx) => (
                    <tr key={idx} className="odd:bg-white even:bg-sh-stripe hover:bg-sh-gray/10">
                      <td className="px-3 py-2 border-b border-sh-gray sticky left-0 bg-inherit font-semibold">
                        {p.itemNumber}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray">{p.description}</td>
                      <td className="px-3 py-2 border-b border-sh-gray text-xs">{p.collection}</td>
                      {GRADES.map((g) => {
                        const gp = p.gradePrices.find((gp) => gp.grade === g);
                        return (
                          <td key={g} className="px-3 py-2 border-b border-sh-gray text-right">
                            {gp ? formatCurrency(gp.retail) : "\u2014"}
                          </td>
                        );
                      })}
                      <td className="px-3 py-2 border-b border-sh-gray text-right">
                        {p.comYardage ?? "\u2014"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {cushionOnlyProducts.length > 100 && (
              <div className="px-3 py-2 text-sm text-sh-gray bg-sh-linen text-center">
                Showing first 100 of {cushionOnlyProducts.length} cushion-only products
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Summer Classics preview ────────────────────────────────────

function SCPreview({ scData }: { scData: SCData }) {
  const { products, collections } = scData;

  const cushionedProducts = products.filter((p) => p.gradePrices.length > 0);
  const frameOnlyProducts = products.filter((p) => p.gradePrices.length === 0);
  const GRADES = ["A", "B", "C", "D"];

  return (
    <div className="space-y-6">
      {/* Summary badges */}
      <div className="flex flex-wrap gap-4">
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{products.length}</span> products
        </div>
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{cushionedProducts.length}</span> cushioned
        </div>
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{frameOnlyProducts.length}</span> frame-only
        </div>
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{collections.length}</span> collections
        </div>
      </div>

      {/* Collections */}
      {collections.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-sh-blue mb-2">
            Collections ({collections.length})
          </h3>
          <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="bg-sh-linen">
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[150px]">Collection</th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[250px]">
                      Available Finishes
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {collections.map((c, idx) => (
                    <tr key={idx} className="odd:bg-white even:bg-sh-stripe hover:bg-sh-gray/10">
                      <td className="px-3 py-2 border-b border-sh-gray font-semibold">{c.name}</td>
                      <td className="px-3 py-2 border-b border-sh-gray text-xs">
                        {c.availableFinishes}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Cushioned products */}
      {cushionedProducts.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-sh-blue mb-2">
            Cushioned Products ({cushionedProducts.length})
          </h3>
          <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="bg-sh-linen">
                    <th className="px-3 py-2 border-b border-sh-gray sticky left-0 bg-sh-linen z-10 min-w-[80px]">
                      Style #
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[80px]">Frame #</th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[200px]">Description</th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[120px]">Collection</th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[130px]">
                      Cushion Type
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[80px]">
                      Frame
                    </th>
                    {GRADES.map((g) => (
                      <th
                        key={g}
                        className="px-3 py-2 border-b border-sh-gray text-right min-w-[70px]"
                      >
                        {g}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cushionedProducts.slice(0, 100).map((p, idx) => (
                    <tr key={idx} className="odd:bg-white even:bg-sh-stripe hover:bg-sh-gray/10">
                      <td className="px-3 py-2 border-b border-sh-gray sticky left-0 bg-inherit font-semibold">
                        {p.styleNumber}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray">{p.frameNumber}</td>
                      <td className="px-3 py-2 border-b border-sh-gray">{p.description}</td>
                      <td className="px-3 py-2 border-b border-sh-gray text-xs">{p.collection}</td>
                      <td className="px-3 py-2 border-b border-sh-gray text-xs">
                        {p.cushionType || "\u2014"}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray text-right">
                        {formatCurrency(p.framePrice)}
                      </td>
                      {GRADES.map((g) => {
                        const gp = p.gradePrices.find((gp) => gp.grade === g);
                        return (
                          <td key={g} className="px-3 py-2 border-b border-sh-gray text-right">
                            {gp ? formatCurrency(gp.cost) : "\u2014"}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {cushionedProducts.length > 100 && (
              <div className="px-3 py-2 text-sm text-sh-gray bg-sh-linen text-center">
                Showing first 100 of {cushionedProducts.length} cushioned products
              </div>
            )}
          </div>
        </div>
      )}

      {/* Frame-only products */}
      {frameOnlyProducts.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-sh-blue mb-2">
            Frame-Only Products ({frameOnlyProducts.length})
          </h3>
          <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="bg-sh-linen">
                    <th className="px-3 py-2 border-b border-sh-gray sticky left-0 bg-sh-linen z-10 min-w-[100px]">
                      Style #
                    </th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[250px]">Description</th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[120px]">Collection</th>
                    <th className="px-3 py-2 border-b border-sh-gray min-w-[160px]">Dimensions</th>
                    <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[80px]">
                      Frame Price
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {frameOnlyProducts.slice(0, 100).map((p, idx) => (
                    <tr key={idx} className="odd:bg-white even:bg-sh-stripe hover:bg-sh-gray/10">
                      <td className="px-3 py-2 border-b border-sh-gray sticky left-0 bg-inherit font-semibold">
                        {p.styleNumber}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray">{p.description}</td>
                      <td className="px-3 py-2 border-b border-sh-gray text-xs">{p.collection}</td>
                      <td className="px-3 py-2 border-b border-sh-gray text-xs">
                        {p.dimensions || "\u2014"}
                      </td>
                      <td className="px-3 py-2 border-b border-sh-gray text-right">
                        {formatCurrency(p.framePrice)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {frameOnlyProducts.length > 100 && (
              <div className="px-3 py-2 text-sm text-sh-gray bg-sh-linen text-center">
                Showing first 100 of {frameOnlyProducts.length} frame-only products
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── American Leather preview ────────────────────────────────────

function ALPreview({ alData }: { alData: ALData }) {
  const { products, pages, collections, isRetail } = alData;

  const allGrades = new Set<string>();
  for (const p of products) {
    for (const gp of p.gradePrices) {
      allGrades.add(gp.grade);
    }
  }
  const GRADE_ORDER = ["C", "D/F", "G", "H", "J", "I", "II", "III", "V"];
  const sortedGrades = GRADE_ORDER.filter((g) => allGrades.has(g));

  // Summarize detected option categories and standard features from pages
  const detectedOptionTypes: string[] = [];
  let stdFeaturesCount = 0;
  const stdFeaturesPreview: string[] = [];
  if (pages && pages.length > 0) {
    const allOptionsText = pages.map((pg) => pg.optionsText).join("\n");
    if (/\*(Dwn|Tufted|Trillium)\b/i.test(allOptionsText)) detectedOptionTypes.push("Cushion Fill");
    if (/MATTRESS\s+OPTIONS/i.test(allOptionsText)) detectedOptionTypes.push("Mattress Upgrade");
    if (/Power\s*=?\s*\$/i.test(allOptionsText)) detectedOptionTypes.push("Power");
    if (/Battery\s*=?\s*\$/i.test(allOptionsText)) detectedOptionTypes.push("Battery");
    if (/Lumbar\s*=?\s*\$/i.test(allOptionsText)) detectedOptionTypes.push("Lumbar");

    // Detect general priced options (Name = $N excluding already-detected types)
    const generalMatches = allOptionsText.match(
      /\b(?!Power|Battery|Lumbar|Stitch)([\w][\w\s]*?)\s*=\s*\$\s*\d/gi,
    );
    if (generalMatches) {
      const seen = new Set(["dwn", "tufted", "trillium"]);
      for (const m of generalMatches) {
        const name = m.replace(/\s*=\s*\$\s*\d.*$/, "").trim();
        if (!seen.has(name.toLowerCase()) && name.length > 1) {
          seen.add(name.toLowerCase());
          detectedOptionTypes.push(name);
        }
      }
    }

    // Count pages with standard features
    for (const pg of pages) {
      if (pg.standardFeaturesText && pg.standardFeaturesText.length > 0) {
        stdFeaturesCount++;
        if (stdFeaturesPreview.length < 3) {
          stdFeaturesPreview.push(
            `${pg.collectionName}: ${pg.standardFeaturesText.split("\n")[0]}`,
          );
        }
      }
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4">
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{products.length}</span> products
        </div>
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{collections.length}</span> collections
        </div>
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          {isRetail ? "Retail MRP" : "Wholesale"}
        </div>
        {detectedOptionTypes.length > 0 && (
          <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
            Options: {detectedOptionTypes.join(", ")}
          </div>
        )}
        {stdFeaturesCount > 0 && (
          <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
            Standard Features: {stdFeaturesCount} page{stdFeaturesCount !== 1 ? "s" : ""}
          </div>
        )}
      </div>

      {stdFeaturesPreview.length > 0 && (
        <details className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
          <summary className="px-4 py-2 bg-sh-linen text-sm font-medium cursor-pointer hover:bg-sh-gray/10">
            Standard Features Preview
          </summary>
          <div className="px-4 py-3 text-sm space-y-1">
            {pages
              ?.filter((pg) => pg.standardFeaturesText?.length > 0)
              .map((pg, i) => (
                <div key={i} className="border-b border-sh-stripe last:border-b-0 pb-2 last:pb-0">
                  <span className="font-semibold text-sh-blue">{pg.collectionName}</span>
                  <span className="text-sh-gray ml-2 text-xs">{pg.programType}</span>
                  <p className="text-sh-gray mt-1 whitespace-pre-line">{pg.standardFeaturesText}</p>
                </div>
              ))}
          </div>
        </details>
      )}

      <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="bg-sh-linen">
                <th className="px-3 py-2 border-b border-sh-gray sticky left-0 bg-sh-linen z-10 min-w-[120px]">
                  Frame #
                </th>
                <th className="px-3 py-2 border-b border-sh-gray min-w-[180px]">Description</th>
                <th className="px-3 py-2 border-b border-sh-gray min-w-[120px]">Collection</th>
                <th className="px-3 py-2 border-b border-sh-gray min-w-[100px]">Program</th>
                <th className="px-3 py-2 border-b border-sh-gray text-right min-w-[50px]">COM</th>
                {sortedGrades.map((g) => (
                  <th key={g} className="px-3 py-2 border-b border-sh-gray text-right min-w-[70px]">
                    {g}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {products.slice(0, 200).map((p, idx) => {
                const gradeMap = new Map(p.gradePrices.map((gp) => [gp.grade, gp.cost]));
                return (
                  <tr key={idx} className="odd:bg-white even:bg-sh-stripe hover:bg-sh-gray/10">
                    <td className="px-3 py-2 border-b border-sh-gray sticky left-0 bg-inherit font-semibold">
                      {p.frameNumber}
                    </td>
                    <td className="px-3 py-2 border-b border-sh-gray">{p.description}</td>
                    <td className="px-3 py-2 border-b border-sh-gray text-xs">
                      {p.collectionName}
                    </td>
                    <td className="px-3 py-2 border-b border-sh-gray text-xs">{p.programType}</td>
                    <td className="px-3 py-2 border-b border-sh-gray text-right text-xs">
                      {p.comUsage ?? "\u2014"}
                    </td>
                    {sortedGrades.map((g) => (
                      <td key={g} className="px-3 py-2 border-b border-sh-gray text-right">
                        {gradeMap.has(g) ? formatCurrency(gradeMap.get(g)!) : "\u2014"}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {products.length > 200 && (
          <div className="px-3 py-2 text-sm text-sh-gray bg-sh-linen text-center">
            Showing first 200 of {products.length} products
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Ekornes / Stressless preview ────────────────────────────────

function EkornesPreview({ ekData }: { ekData: EkornesData }) {
  const { products, collections, gradeTiers, fabrics } = ekData;

  const GRADE_SORT: Record<string, number> = {
    Batick: 0,
    Fabric: 1,
    Paloma: 2,
    Dinamica: 3,
    Velaro: 4,
    Noblesse: 5,
    MAP: 6,
    FLAT: 7,
  };
  const sortedTiers = [...gradeTiers].sort((a, b) => (GRADE_SORT[a] ?? 99) - (GRADE_SORT[b] ?? 99));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4">
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{products.length}</span> products
        </div>
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{collections.length}</span> collections
        </div>
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{sortedTiers.length}</span> grade tiers
        </div>
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">{fabrics?.length || 0}</span>{" "}
          fabrics/leathers
        </div>
        <div className="bg-sh-linen rounded-lg px-4 py-2 text-sm">
          <span className="font-semibold text-sh-blue">
            {products.reduce((sum, p) => sum + p.gradePrices.length, 0)}
          </span>{" "}
          price points
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {sortedTiers.map((tier) => (
          <span
            key={tier}
            className="inline-flex items-center gap-1 bg-white border border-sh-gray/30 rounded-full px-3 py-1 text-xs"
          >
            <span className="font-semibold text-sh-blue">{tier}</span>
            <span className="text-sh-gray">
              ({products.filter((p) => p.gradePrices.some((gp) => gp.grade === tier)).length})
            </span>
          </span>
        ))}
      </div>

      <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="bg-sh-linen">
                <th className="px-3 py-2 border-b border-sh-gray sticky left-0 bg-sh-linen z-10 min-w-[90px]">
                  Material #
                </th>
                <th className="px-3 py-2 border-b border-sh-gray min-w-[100px]">Collection</th>
                <th className="px-3 py-2 border-b border-sh-gray min-w-[140px]">Description</th>
                <th className="px-3 py-2 border-b border-sh-gray min-w-[70px]">Base</th>
                {sortedTiers.map((tier) => (
                  <th
                    key={tier}
                    className="px-3 py-2 border-b border-sh-gray text-right min-w-[80px]"
                  >
                    {tier}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {products.slice(0, 50).map((p, idx) => {
                const priceMap = new Map(p.gradePrices.map((gp) => [gp.grade, gp.mrp]));
                return (
                  <tr key={idx} className="odd:bg-white even:bg-sh-stripe hover:bg-sh-gray/10">
                    <td className="px-3 py-2 border-b border-sh-gray font-semibold sticky left-0 bg-inherit z-10">
                      {p.materialNumber}
                    </td>
                    <td className="px-3 py-2 border-b border-sh-gray text-xs">{p.collection}</td>
                    <td className="px-3 py-2 border-b border-sh-gray">{p.description}</td>
                    <td className="px-3 py-2 border-b border-sh-gray text-xs">{p.base || "—"}</td>
                    {sortedTiers.map((tier) => (
                      <td
                        key={tier}
                        className="px-3 py-2 border-b border-sh-gray text-right tabular-nums"
                      >
                        {priceMap.has(tier) ? formatCurrency(priceMap.get(tier)!) : "—"}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {products.length > 50 && (
          <div className="px-3 py-2 text-sm text-sh-gray bg-sh-linen text-center">
            Showing first 50 of {products.length} products
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────

const formatCurrency = (val: number) =>
  val.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
  });
