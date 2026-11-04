// /app/src/lib/sales/orderFlagsShared.ts
//
// GAP-07: what a flag on an order looks like, read by both the server
// (lib/sales/orderFlags.ts, which refuses any other colour) and every screen
// that draws one (the order page, the orders list, dispatch, Settings > Order
// flags), so a colour the store picks always draws.
//
// The store names its own flags; the colours are a fixed set of tones because
// each is a pair of classes that reads on the page, not a value a store types.

export const ORDER_FLAG_COLORS = ["gray", "red", "amber", "green", "blue", "purple"] as const;

export type OrderFlagColor = (typeof ORDER_FLAG_COLORS)[number];

export const ORDER_FLAG_NAME_MAX = 60;

const CHIP_CLASSES: Record<OrderFlagColor, string> = {
  gray: "bg-gray-100 text-gray-800 border-gray-300",
  red: "bg-red-100 text-red-800 border-red-300",
  amber: "bg-amber-100 text-amber-800 border-amber-300",
  green: "bg-green-100 text-green-800 border-green-300",
  blue: "bg-blue-100 text-blue-800 border-blue-300",
  purple: "bg-purple-100 text-purple-800 border-purple-300",
};

export function isOrderFlagColor(value: unknown): value is OrderFlagColor {
  return typeof value === "string" && (ORDER_FLAG_COLORS as readonly string[]).includes(value);
}

/** The chip's classes; a colour no longer in the set draws grey. */
export function orderFlagChipClasses(color: string): string {
  return CHIP_CLASSES[isOrderFlagColor(color) ? color : "gray"];
}

/** A flag as an order carries it, for every screen that draws one. */
export interface OrderFlagRef {
  id: number;
  name: string;
  color: string;
  alertOnOpen: boolean;
}

/** An order's flags as ORDER_FLAGS_SELECT (lib/sales/orderFlags.ts) reads them. */
export interface SelectedOrderFlag {
  orderFlag: OrderFlagRef & { sortOrder: number };
}

/**
 * An order's flags in the store's order. A server route calls it on what it
 * selected; a screen that receives the selected rows as they are (the delivery
 * runs) calls it too.
 */
export function flagRefsOf(rows: readonly SelectedOrderFlag[] | undefined): OrderFlagRef[] {
  return (rows ?? [])
    .map((r) => r.orderFlag)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map(({ id, name, color, alertOnOpen }) => ({ id, name, color, alertOnOpen }));
}

/** The flags that warn whoever opens the order. */
export function openingAlerts(flags: readonly OrderFlagRef[]): OrderFlagRef[] {
  return flags.filter((f) => f.alertOnOpen);
}
