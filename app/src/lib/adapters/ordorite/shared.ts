// /app/src/lib/adapters/ordorite/shared.ts
//
// Ordorite-adapter shared helpers: everything the report runners need that is
// SPECIFIC to Ordorite's CSV conventions (status derivation, order-number
// grammar, tax labels, payment modes, address shape, product lookup).
// Source-agnostic coercion + customer dedup live in @/lib/importHelpers and
// are re-exported here so the runners import one module.

import { PrismaClient, Customer, PurchaseOrderStatus, SalesOrderStatus } from "@prisma/client";

export {
  safeString,
  safeFloat,
  safeDate,
  splitCustomerName,
  isUntrustedMergeEmail,
  findOrCreateCustomer,
} from "@/lib/importHelpers";
import { safeString, safeFloat } from "@/lib/importHelpers";
// ---------------------------------------------------------------------------
// Tax label parsing (Ordorite "Tax Amount" column values)
// ---------------------------------------------------------------------------

export interface ParsedTaxLabel {
  districtShortName: string | null;
  taxRate: number | null;
  exemptReasonName: string | null;
}

/**
 * Parses Ordorite's "Tax Amount" column which contains labels like:
 *   "CT 6.35%"              -> { districtShortName: "CT", taxRate: 0.0635, exemptReasonName: null }
 *   "Tax Exempt - Resale"   -> { districtShortName: null, taxRate: 0, exemptReasonName: "Resale" }
 *   "Tax Exempt - Out of State" -> { districtShortName: null, taxRate: 0, exemptReasonName: "Out of State" }
 */
export function parseTaxLabel(label: unknown): ParsedTaxLabel {
  const s = safeString(label);
  if (!s) return { districtShortName: null, taxRate: null, exemptReasonName: null };

  // Bounded quantifiers prevent polynomial-redos on attacker-controlled
  // strings starting with 'tax exempt-' followed by many repetitions of
  // ' '. {0,16} covers every legitimate Ordorite tax-exempt label.
  // exec() preferred over .match() per Sonar S6594.
  const exemptMatch = /^Tax\s{1,16}Exempt\s{0,16}-\s{0,16}([^\n]+)$/i.exec(s);
  if (exemptMatch) {
    return {
      districtShortName: null,
      taxRate: 0,
      exemptReasonName: exemptMatch[1].trim(),
    };
  }

  const rateMatch = s.match(/^(\w+)\s+([\d.]+)%$/);
  if (rateMatch) {
    return {
      districtShortName: rateMatch[1],
      taxRate: parseFloat(rateMatch[2]) / 100,
      exemptReasonName: null,
    };
  }

  return { districtShortName: null, taxRate: null, exemptReasonName: null };
}

// ---------------------------------------------------------------------------
// Tax district resolution -- lookup or create from parsed label
// ---------------------------------------------------------------------------

const DISTRICT_NAME_MAP: Record<string, string> = {
  CT: "Connecticut State Sales Tax",
  NY: "New York State Sales Tax",
  NJ: "New Jersey State Sales Tax",
  MA: "Massachusetts State Sales Tax",
};

export async function resolveTaxDistrictId(
  prisma: PrismaClient,
  parsed: ParsedTaxLabel,
): Promise<number | null> {
  if (!parsed.districtShortName) return null;

  const district = await prisma.taxDistrict.findUnique({
    where: { shortName: parsed.districtShortName },
  });

  if (district) return district.id;

  const created = await prisma.taxDistrict.create({
    data: {
      shortName: parsed.districtShortName,
      state: parsed.districtShortName,
      name: DISTRICT_NAME_MAP[parsed.districtShortName] || `${parsed.districtShortName} Tax`,
    },
  });
  return created.id;
}

export async function resolveTaxExemptReasonId(
  prisma: PrismaClient,
  reasonName: string,
): Promise<number> {
  const existing = await prisma.taxExemptReason.findUnique({
    where: { name: reasonName },
  });
  if (existing) return existing.id;

  const created = await prisma.taxExemptReason.create({
    data: { name: reasonName },
  });
  return created.id;
}

// ---------------------------------------------------------------------------
// Payment mode mapping (Ordorite numeric codes to readable names)
// ---------------------------------------------------------------------------

const PAYMENT_MODE_MAP: Record<string, string> = {
  "1": "Finance",
  "2": "Wire Transfer",
  "4": "Check",
  "5": "Cash",
  "6": "Gift Card",
  "9": "Store Credit",
  "11": "ACH",
  "20": "Debit",
  "27": "Card Connect",
  "28": "Card Not Present",
  "29": "Credit Note",
  "30": "Charity",
  "32": "Marketing",
  "33": "Other",
  Refund: "Refund",
};

export function resolvePaymentMode(mode: unknown): string {
  const s = safeString(mode);
  if (!s) return "Unknown";
  // Ordorite exports numeric codes with decimals (e.g., "27.00" instead of "27")
  const normalized = s.replace(/\.0+$/, "");
  return PAYMENT_MODE_MAP[normalized] || PAYMENT_MODE_MAP[s] || s;
}

// Refund types: negative amounts or explicit refund payment modes
const REFUND_MODES = new Set(["Refund", "Credit Note"]);

export function isRefundPayment(paymentType: string, amount: number): boolean {
  return amount < 0 || REFUND_MODES.has(paymentType);
}

// ---------------------------------------------------------------------------
// Return / refund detection for sales order imports
// ---------------------------------------------------------------------------

const RETURN_ORDER_PREFIX = /^(R|CR)-?\d/i;

// Ordorite uses an "A" suffix on the store code for return/credit transactions:
// SBOA = Saybrook Old return, GTOA = Glastonbury return, CHOA = Cheshire return.
// The "M" suffix (SBOM, GTOM, CHOM) is for regular merchandise orders.
const RETURN_STORE_SUFFIX = /^(SB|GT|CH|BB|WS|RS)[A-Z]*A\d/i;

// Rewrite-suffix matching. Ordorite rewrites replace the original order; the
// new order number is "<base> - A" (or B/C/D up to D). Everything that was on
// the base belongs to the rewrite going forward.
// Bounded quantifiers prevent polynomial-redos on inputs that are mostly
// whitespace (e.g. a CSV cell that is just spaces). Real Ordorite order
// numbers like "SBOM38721 - A" use exactly " - " (one space each side);
// {0,8} is generous.
const REWRITE_SUFFIX_RE = /\s{0,8}-\s{0,8}([A-D])$/;

/** True when the order number is a rewrite (has " - A/B/C/D" suffix). */
export function isRewriteOrder(orderno: string): boolean {
  return REWRITE_SUFFIX_RE.test(orderno);
}

/**
 * Extract the base orderno from a rewrite. Returns null if this is not a
 * rewrite.
 *
 *   rewriteBaseOrderno("SBOM38549 - A") === "SBOM38549"
 *   rewriteBaseOrderno("SBOM38549")     === null
 */
export function rewriteBaseOrderno(orderno: string): string | null {
  if (!REWRITE_SUFFIX_RE.test(orderno)) return null;
  return orderno.replace(REWRITE_SUFFIX_RE, "").trim();
}

/** True when the order number follows Ordorite's return/credit convention. */
export function isReturnOrder(orderno: string): boolean {
  // RS-prefixed orders are Returns Saybrook
  if (/^RS\d/i.test(orderno)) return true;
  return RETURN_ORDER_PREFIX.test(orderno) || RETURN_STORE_SUFFIX.test(orderno);
}

/**
 * Derives the SalesOrderStatus from Ordorite CSV data.
 *
 * Returns are identified by:
 *   - Order numbers prefixed with R or CR (e.g. R12345, CR-12345)
 *   - Negative net total across all line items
 *   - An explicit "Cancelled" or "Return" value in the Status column
 *
 * Orders that are not returns get ORDER status (Ordorite only exports
 * confirmed orders, never drafts/quotes).
 */
export function deriveSalesOrderStatus(
  orderno: string,
  lineItems: Record<string, unknown>[],
  statusField?: string,
): SalesOrderStatus {
  // Explicit "cancelled" status from Ordorite means a voided quote — not a return
  if (statusField) {
    const lower = statusField.toLowerCase().trim();
    if (lower === "cancelled") {
      return "CANCELLED";
    }
    // "return" or "returned" are actual return transactions
    if (lower === "return" || lower === "returned") {
      return "RETURNED";
    }
  }

  // Order number prefix convention (R/CR-prefixed = return)
  if (isReturnOrder(orderno)) {
    return "RETURNED";
  }

  // Negative net total indicates a return/refund order (e.g. SBOA*, GTOA*)
  let total = 0;
  for (const row of lineItems) {
    total += safeFloat(row.netprice);
  }
  if (total < 0) {
    return "RETURNED";
  }

  // Ordorite exports are confirmed orders, not quotes
  return "ORDER";
}

// ---------------------------------------------------------------------------
// Email validation
// ---------------------------------------------------------------------------

export function isValidEmail(email: string): boolean {
  // Bounded quantifiers prevent the polynomial-redos backtracking the
  // unbounded `[^\s@]+@[^\s@]+\.[^\s@]+` pattern would have allowed on
  // attacker-supplied inputs. 256/256/256 is comfortably above any real
  // email (RFC caps total at 254) and bounds worst-case scan to O(n).
  if (email.length > 256) return false;
  return /^[^\s@]{1,256}@[^\s@]{1,256}\.[^\s@]{1,256}$/.test(email);
}

export function normalizeEmail(raw: unknown): string | null {
  const s = safeString(raw);
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower === "@" || !isValidEmail(lower)) return null;
  return lower;
}

// ---------------------------------------------------------------------------
// Address parsing (Ordorite CSV format: "street, city, state, country")
// ---------------------------------------------------------------------------

export interface ParsedAddress {
  address1: string;
  city: string;
  state: string;
}

export function parseOrdoriteAddress(raw: unknown): ParsedAddress | null {
  const s = safeString(raw);
  if (!s) return null;

  const parts = s
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  // Drop trailing country name (e.g. "United States", "USA")
  const last = parts[parts.length - 1]?.toLowerCase();
  if (last === "united states" || last === "usa" || last === "us") {
    parts.pop();
  }

  // Drop trailing zip code that ended up as its own part (e.g. "CT, 06033")
  const ZIP_RE = /^\d{5}(-\d{4})?$/;
  if (parts.length >= 4 && ZIP_RE.test(parts[parts.length - 1])) {
    parts.pop();
  }

  // Need at least 3 parts: address, city, state
  if (parts.length < 3) return null;

  // Parse from the end: state is last, city is second-to-last,
  // everything else is the street address (handles unit/apt prefixes)
  let state = parts[parts.length - 1];
  const city = parts[parts.length - 2];
  const address1 = parts.slice(0, parts.length - 2).join(", ");

  // Strip zip code merged into state (e.g. "CT 06033" -> "CT")
  const stateZipMatch = state.match(/^([A-Z]{2})\s+\d{5}/);
  if (stateZipMatch) {
    state = stateZipMatch[1];
  }

  if (!address1 || !city || !state) return null;
  return { address1, city, state };
}

// ---------------------------------------------------------------------------
// Product lookup / auto-creation for imports
// ---------------------------------------------------------------------------

interface FindProductOptions {
  externalId?: string;
  partNo?: string;
  productName?: string;
  unitCost?: number;
  vendorId?: number;
  autoCreate?: boolean;
  createdBy?: string;
}

// Module-level caches for the auto-create fallback buckets. These IDs
// are stable for the lifetime of the process; the underlying Vendor /
// Department / Category rows are created on first use and reused for
// every subsequent auto-create that lacks an explicit one.
//
// In integration tests, these caches MUST be cleared between TRUNCATE
// resets — the cached id survives the JS module load while the
// underlying row gets wiped, leading to FK violations on the next
// auto-create. `resetTestDb()` calls `clearAutoCreateCachesForTesting()`
// to handle this.
let cachedUnknownVendorId: number | null = null;
let cachedUncategorizedTaxonomy: { departmentId: number; categoryId: number } | null = null;

/**
 * Test-only helper: reset the module-level auto-create caches so the
 * next call to `findProduct({ autoCreate: true, ... })` re-resolves the
 * Unknown Vendor / Uncategorized rows against the (truncated) test DB.
 *
 * Called by `lib/testing/withTestDb.ts:resetTestDb()`. Production code
 * should never call this — the caches are correct under live DB
 * operation because rows aren't truncated mid-process.
 */
export function clearAutoCreateCachesForTesting(): void {
  cachedUnknownVendorId = null;
  cachedUncategorizedTaxonomy = null;
}

export async function ensureUnknownVendorId(prisma: PrismaClient): Promise<number> {
  if (cachedUnknownVendorId !== null) return cachedUnknownVendorId;
  const existing = await prisma.vendor.findFirst({
    where: { name: { equals: "Unknown Vendor", mode: "insensitive" } },
    select: { id: true },
  });
  if (existing) {
    cachedUnknownVendorId = existing.id;
    return existing.id;
  }
  const created = await prisma.vendor.create({
    data: { name: "Unknown Vendor", pricingModel: "FLAT" },
    select: { id: true },
  });
  cachedUnknownVendorId = created.id;
  return created.id;
}

async function ensureUncategorizedTaxonomy(
  prisma: PrismaClient,
): Promise<{ departmentId: number; categoryId: number }> {
  if (cachedUncategorizedTaxonomy) return cachedUncategorizedTaxonomy;

  let dept = await prisma.department.findFirst({
    where: { name: { equals: "Uncategorized", mode: "insensitive" } },
    select: { id: true },
  });
  if (!dept) {
    dept = await prisma.department.create({
      data: { name: "Uncategorized" },
      select: { id: true },
    });
  }

  let cat = await prisma.category.findFirst({
    where: {
      name: { equals: "Uncategorized", mode: "insensitive" },
      departmentId: dept.id,
    },
    select: { id: true },
  });
  if (!cat) {
    cat = await prisma.category.create({
      data: { name: "Uncategorized", departmentId: dept.id },
      select: { id: true },
    });
  }

  cachedUncategorizedTaxonomy = { departmentId: dept.id, categoryId: cat.id };
  return cachedUncategorizedTaxonomy;
}

export async function findProduct(
  prisma: PrismaClient,
  externalIdOrOpts?: string | FindProductOptions,
  partNo?: string,
): Promise<{ id: number } | null> {
  // Support both old signature (externalId, partNo) and new options object
  const opts: FindProductOptions =
    typeof externalIdOrOpts === "object" && externalIdOrOpts !== null
      ? externalIdOrOpts
      : { externalId: externalIdOrOpts, partNo };

  if (opts.externalId) {
    const numId = Number.parseInt(opts.externalId, 10);
    if (!Number.isNaN(numId)) {
      const product = await prisma.product.findUnique({
        where: { externalId: numId },
        select: { id: true },
      });
      if (product) return product;
    }
  }

  if (opts.partNo) {
    const product = await prisma.product.findFirst({
      where: { productNumber: { equals: opts.partNo, mode: "insensitive" } },
      select: { id: true },
    });
    if (product) return product;
  }

  // Auto-create if requested and we have at least a part number.
  //
  // Product schema requires vendor / department / category as relations
  // (vendorId / departmentId / categoryId scalars + relation directives).
  // Prisma 7 rejects partial scalar+relation input when a checked-mode
  // relation is required, even if the scalar foreign-key is provided —
  // it returns "Argument `vendor` is missing" with the relation form
  // hint. So we use the connect form for all three required relations
  // here. When callers don't pass a vendorId (temp-items rows with no
  // Supplier column, received-items imported before the master PO
  // arrived) we fall back to shared "Unknown Vendor" / "Uncategorized"
  // buckets so the row still imports rather than crashing the whole
  // batch. Operator recategorizes later from
  // /admin/tools/categorize-products.
  if (opts.autoCreate && opts.partNo) {
    const numId = opts.externalId ? Number.parseInt(opts.externalId, 10) : undefined;

    const vendorId = opts.vendorId ?? (await ensureUnknownVendorId(prisma));
    const { departmentId, categoryId } = await ensureUncategorizedTaxonomy(prisma);

    const createData: Record<string, unknown> = {
      productNumber: opts.partNo,
      name: opts.productName || opts.partNo,
      baseCost: opts.unitCost ?? 0,
      vendor: { connect: { id: vendorId } },
      department: { connect: { id: departmentId } },
      category: { connect: { id: categoryId } },
      createdBy: opts.createdBy || "auto-import",
    };
    if (numId && !Number.isNaN(numId)) createData.externalId = numId;

    const product = await prisma.product.create({
      data: createData as any,
      select: { id: true },
    });
    return product;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Flexible date parsing for Ordorite exports
// ---------------------------------------------------------------------------

export function parseDateFlexible(v: unknown): Date | undefined {
  const s = safeString(v);
  if (!s) return undefined;

  // MM/DD/YYYY (receiving lines format)
  const mdyMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdyMatch) {
    const d = new Date(
      Number.parseInt(mdyMatch[3]),
      Number.parseInt(mdyMatch[1]) - 1,
      Number.parseInt(mdyMatch[2]),
    );
    if (!Number.isNaN(d.getTime())) return d;
  }

  // YYYY-MM-DD (POR export format)
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const d = new Date(
      Number.parseInt(isoMatch[1]),
      Number.parseInt(isoMatch[2]) - 1,
      Number.parseInt(isoMatch[3]),
    );
    if (!Number.isNaN(d.getTime())) return d;
  }

  // Fallback to native parser
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// ---------------------------------------------------------------------------
// PO status mapping from Ordorite status strings
// ---------------------------------------------------------------------------

const PO_STATUS_MAP: Record<string, PurchaseOrderStatus> = {
  received: "RECEIVED_FULL",
  cancelled: "CANCELLED",
  "part received": "RECEIVED_PARTIAL",
  // Ordorite's "Temporary" Postatus means a PO exists but hasn't been
  // finalized / submitted to a vendor yet. Maps to DRAFT in our enum
  // so reports / dispatch boards can filter temps out of "ready to
  // receive" surfaces. Added 2026-05-21 after PR #314 wired the
  // renamed Daily Quote Temp Purchase Orders report — the runner had
  // been hardcoding CONFIRMED, but had never received data until the
  // rename landed. See docs/domains/purchasing.md + ordorite-import.md.
  temporary: "DRAFT",
};

export function derivePOStatus(statusString: unknown): PurchaseOrderStatus {
  const s = safeString(statusString);
  if (!s) return "CONFIRMED";
  return PO_STATUS_MAP[s.toLowerCase()] || "CONFIRMED";
}

// Decide a PO's status from a receipt tally. Callers must pre-filter both
// counts to lines with `orderedQuantity > 0` -- 0-qty lines are cancelled
// lines from Ordorite and must never count toward either total. Returns
// `null` when the status should stay as-is (nothing to receive, or
// nothing received yet). GitHub #113, CLAUDE.md rule 39.
export function classifyPOReceiptStatus(
  itemCount: number,
  receivedItemCount: number,
): "RECEIVED_FULL" | "RECEIVED_PARTIAL" | null {
  if (itemCount <= 0) return null;
  if (receivedItemCount >= itemCount) return "RECEIVED_FULL";
  if (receivedItemCount > 0) return "RECEIVED_PARTIAL";
  return null;
}
