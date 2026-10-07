// /app/src/lib/frameRollup.ts
//
// Data-driven frame rollup for the Buyers Report. A "frame" is the base
// product without its configuration suffix -- e.g. Wesley Hall's
// SE-F21-XLS / SE-F21-LS / SE-F21-S all share frame SE-F21. A Home
// Accessories vendor like Uttermost usually has UTT-19432 / UTT-19433
// etc. with no shared root; each SKU is already at the frame level.
//
// Rather than maintain a hardcoded per-vendor registry (which goes stale
// whenever conventions change or a new vendor is onboarded), this helper
// decides at query time: for each vendor in the input set, compute how
// many distinct SKUs map to the same root (= SKU with its last
// `-`-delimited segment removed). If the average configs-per-root for
// that vendor is >= MIN_CONFIGS_PER_ROOT, the vendor has configurable
// frames and we roll up. Otherwise we treat each SKU as its own frame
// (no-op). The classifier's output is itself interesting -- we expose it
// so the UI can show "rolled up" badges.
//
// Pure helper, no DB access, fully testable.

// Average configs-per-root threshold above which a vendor is deemed to
// have configurable frames. 1.5 = "on average, each root has at least
// 1.5 SKUs under it". Tuned from production analysis: every vendor
// with clear frame conventions sits at >= 2.0; vendors with flat SKU
// spaces sit at 1.0 - 1.1. 1.5 is the safe middle ground.
export const MIN_CONFIGS_PER_ROOT = 1.5;

// Minimum product count before a vendor can be classified. Below this,
// the ratio is too noisy to trust -- treat as flat SKU space.
export const MIN_PRODUCTS_FOR_CLASSIFICATION = 5;

export interface FrameInput {
  productId: number;
  productNumber: string | null;
  vendorId: number | null;
}

export interface FrameDecision {
  // Frame key the product should roll up to. If the vendor is classified
  // as flat, frame === productNumber (so it's still per-product).
  frameKey: string;
  // Human-readable frame label. Same as frameKey for now.
  frameLabel: string;
  // True if the vendor's pattern was detected as configurable and we
  // actually collapsed this SKU's suffix.
  collapsed: boolean;
}

// Strip the last `-`-delimited segment from a SKU. `SE-F21-XLS` -> `SE-F21`.
// SKUs with no `-` return as-is. Empty / whitespace-only after strip also
// fall back to the original SKU so we never lose identity.
export function stripLastSegment(sku: string): string {
  const idx = sku.lastIndexOf("-");
  if (idx <= 0) return sku;
  const root = sku.slice(0, idx).trim();
  return root.length > 0 ? root : sku;
}

// Part-number convention: most SKUs are `<vendorPrefix>-<vendorSku>`.
// For frame rollup the
// vendorPrefix is not meaningful -- we need to reason about the vendor's
// own SKU portion. Strip the first segment; if there's nothing left
// (single-segment SKU with no vendor prefix), return the original.
function stripVendorPrefix(sku: string): string {
  const idx = sku.indexOf("-");
  if (idx <= 0) return sku;
  const rest = sku.slice(idx + 1).trim();
  return rest.length > 0 ? rest : sku;
}

// Classify every vendor in the input: is their pattern configurable
// (avg >= threshold) or flat? Returns a Set of vendorIds that are
// configurable. Vendors absent from the Set are flat.
//
// Classification happens within the vendor's OWN SKU portion (after
// stripping the vendor prefix). A vendor whose vendorSkus are
// single-segment identifiers (e.g. `UTT-19432` -> `19432`) has no hyphens
// to split on and is by definition flat. A vendor with multi-segment
// vendorSkus (e.g. `WH-SE-F21-XLS` -> `SE-F21-XLS`) gets the last-segment
// rollup treatment.
export function classifyVendors(inputs: FrameInput[]): Set<number> {
  const byVendor = new Map<number, string[]>();
  for (const i of inputs) {
    if (i.vendorId == null || !i.productNumber) continue;
    const list = byVendor.get(i.vendorId) ?? [];
    list.push(i.productNumber);
    byVendor.set(i.vendorId, list);
  }
  const configurable = new Set<number>();
  for (const [vendorId, skus] of byVendor) {
    if (skus.length < MIN_PRODUCTS_FOR_CLASSIFICATION) continue;
    const vendorSkus = skus.map(stripVendorPrefix);
    // Any vendorSku that has no hyphens is single-segment -- flat by
    // construction. If none of the vendor's skus have a hyphen in their
    // vendor-SKU portion, skip the vendor entirely.
    const hasSubstructure = vendorSkus.some((s) => s.includes("-"));
    if (!hasSubstructure) continue;
    const rootCounts = new Map<string, number>();
    for (const vs of vendorSkus) {
      const root = stripLastSegment(vs);
      rootCounts.set(root, (rootCounts.get(root) ?? 0) + 1);
    }
    const avgConfigsPerRoot = vendorSkus.length / rootCounts.size;
    if (avgConfigsPerRoot >= MIN_CONFIGS_PER_ROOT) configurable.add(vendorId);
  }
  return configurable;
}

// Build a productId -> FrameDecision map. When `enabled` is false every
// product gets frameKey = productNumber (caller still gets a per-product
// row, matching the non-rollup behavior). When enabled we strip the last
// segment for products whose vendor classified as configurable.
export function buildFrameDecisions(
  inputs: FrameInput[],
  enabled: boolean,
): Map<number, FrameDecision> {
  const out = new Map<number, FrameDecision>();
  if (!enabled) {
    for (const i of inputs) {
      const fallback = i.productNumber ?? String(i.productId);
      out.set(i.productId, {
        frameKey: `${i.vendorId ?? 0}:${fallback}`,
        frameLabel: fallback,
        collapsed: false,
      });
    }
    return out;
  }
  const configurable = classifyVendors(inputs);
  for (const i of inputs) {
    const sku = i.productNumber ?? String(i.productId);
    const isConfigurableVendor = i.vendorId != null && configurable.has(i.vendorId);
    if (!isConfigurableVendor) {
      out.set(i.productId, {
        frameKey: `${i.vendorId ?? 0}:${sku}`,
        frameLabel: sku,
        collapsed: false,
      });
      continue;
    }
    // Strip within the vendor's own sku portion, then re-compose as
    // <vendorPrefix>-<rootOfVendorSku> so labels remain readable.
    const vendorPrefix = sku.slice(0, Math.max(0, sku.indexOf("-")));
    const vendorSku = stripVendorPrefix(sku);
    const vendorRoot = stripLastSegment(vendorSku);
    const collapsed = vendorRoot !== vendorSku;
    const label = collapsed && vendorPrefix ? `${vendorPrefix}-${vendorRoot}` : vendorRoot;
    out.set(i.productId, {
      frameKey: `${i.vendorId ?? 0}:${label}`,
      frameLabel: label,
      collapsed,
    });
  }
  return out;
}
