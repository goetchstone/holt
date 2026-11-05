// /app/src/lib/pipelineClient.ts
//
// Who a pipeline quote is for: which customer rows are a real client, and whether
// their number on file can be dialed. Pure, so the card and the API share it.

/** A POS's history often lands register sales on one "Cash Sale" customer, so anything
 *  client-level (notes, profile, purchase history) would mix up unrelated people.
 *  Matched by name so it survives a customer re-import. */
export function isCashSaleCustomer(customer: {
  firstName: string | null;
  lastName: string | null;
}): boolean {
  return (
    customer.firstName?.trim().toLowerCase() === "cash" &&
    customer.lastName?.trim().toLowerCase() === "sale"
  );
}

/** A number worth dialing: leaves out junk like "555" or "000-000-0000". */
export function callablePhone(phone: string | null | undefined): string | null {
  const trimmed = phone?.trim();
  if (!trimmed) return null;
  const digits = trimmed.replaceAll(/\D/g, "");
  const isJunk = digits.length < 10 || /^(\d)\1+$/.test(digits);
  return isJunk ? null : trimmed;
}

/** An address worth emailing. Typed-in trailing punctuation is dropped, and anything
 *  still malformed is left out. */
export function mailableEmail(email: string | null | undefined): string | null {
  const cleaned = email?.trim().replace(/[,;.]+$/, "");
  if (!cleaned) return null;
  return /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(cleaned) ? cleaned : null;
}

/** What a card says is on a quote, from its priced lines. A placeholder has nothing
 *  priced yet. It still marks a real client, since a salesperson may use one to hold
 *  notes or start a conversation. */
export function summarizeQuoteLines(pricedLines: { productName: string | null }[]): {
  summary: string;
  isPlaceholder: boolean;
} {
  const shownCount = 3;
  const names = pricedLines
    .slice(0, shownCount)
    .map((line) => line.productName)
    .filter(Boolean)
    .join(", ");
  const hiddenCount = pricedLines.length - shownCount;
  const summary = hiddenCount > 0 ? `${names} +${hiddenCount} more` : names;
  return {
    summary: summary || "Placeholder, nothing priced yet",
    isPlaceholder: pricedLines.length === 0,
  };
}

export interface LastPurchase {
  id: number;
  orderno: string;
  orderDate: string | null;
  items: string[];
}

/** What Holt already knows about a client: last sale, brands, addresses. */
export interface ClientBackground {
  lastPurchase: LastPurchase | null;
  brands: string[];
  locations: string[];
}

export interface PipelineClientHistory extends ClientBackground {
  lifetimeSpend: number;
  orderCount: number;
  lastOrderDate: string | null;
}

/** The brands a client has spent the most with, biggest first. */
export function topBrands(
  lines: readonly { vendorName: string; lineTotal: number }[],
  limit = 4,
): string[] {
  const spendByBrand = new Map<string, number>();
  for (const line of lines) {
    spendByBrand.set(line.vendorName, (spendByBrand.get(line.vendorName) ?? 0) + line.lineTotal);
  }
  return [...spendByBrand]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([brand]) => brand);
}

/** Each town on file once, since an import can repeat an address per order. */
export function distinctLocations(
  addresses: readonly { city: string; state: string }[],
  limit = 4,
): string[] {
  const byLowerCase = new Map<string, string>();
  for (const { city, state } of addresses) {
    const location = [city.trim(), state.trim()].filter(Boolean).join(", ");
    if (location && !byLowerCase.has(location.toLowerCase())) {
      byLowerCase.set(location.toLowerCase(), location);
    }
  }
  return [...byLowerCase.values()].slice(0, limit);
}

/** The lifetime columns refresh on a schedule, so a client who just bought can still
 *  read zero orders. Their actual sale decides it. */
export function hasPurchased(history: {
  orderCount: number;
  lastPurchase: unknown | null;
}): boolean {
  return history.orderCount > 0 || history.lastPurchase !== null;
}
