// /app/src/lib/storeColors.ts
//
// Consistent color palette for store-level charts. Colors are assigned
// by index so new stores automatically get a color without code changes.
//
// Display name mapping turns traffic-counter (Axper) API names into friendly
// location labels. The example mappings below are placeholders — replace them
// with your traffic counter's store names. Multiple counter names can map to
// one location (e.g. two co-located buildings counted separately).

const STORE_COLORS = [
  "#1e40af", // blue
  "#16a34a", // green
  "#d97706", // amber
  "#9333ea", // purple
  "#dc2626", // red
  "#0891b2", // cyan
  "#c026d3", // fuchsia
  "#65a30d", // lime
];

const STORE_COLORS_LIGHT = [
  "#93c5fd", // blue light
  "#6ee7b7", // green light
  "#fdba74", // amber light
  "#c4b5fd", // purple light
  "#fca5a5", // red light
  "#67e8f9", // cyan light
  "#f0abfc", // fuchsia light
  "#bef264", // lime light
];

/**
 * Maps Axper API store_name values to user-friendly display names.
 * Add new entries here when Axper adds stores.
 */
const STORE_DISPLAY_NAMES: Record<string, string> = {
  "Main Showroom": "Main Showroom",
  "West Showroom": "West Showroom",
};

/**
 * Maps traffic-counter store names to StoreLocation.name values used in
 * payment/sales records. The counter and the POS often use different naming
 * schemes for the same physical store. Multiple counter names can map to the
 * same StoreLocation (e.g. two co-located buildings), in which case sales
 * figures are shared across those entries. Example placeholders — replace
 * with your own.
 */
const AXPER_TO_STORE_LOCATION: Record<string, string> = {
  "Main Showroom": "Main Showroom",
  "West Showroom": "West Showroom",
};

/**
 * Returns a friendly display name for a store, or the raw name if not mapped.
 */
export function getStoreDisplayName(axperName: string): string {
  return STORE_DISPLAY_NAMES[axperName] ?? axperName;
}

/**
 * Returns the StoreLocation.name that corresponds to an Axper store name,
 * or the raw Axper name if no mapping exists. Used to look up sales data
 * for a given traffic store.
 */
export function getStoreLocationName(axperName: string): string {
  return AXPER_TO_STORE_LOCATION[axperName] ?? axperName;
}

/**
 * Returns a consistent background color for a store based on its index.
 */
export function getStoreColor(index: number, variant: "solid" | "light" = "solid"): string {
  const palette = variant === "light" ? STORE_COLORS_LIGHT : STORE_COLORS;
  return palette[index % palette.length];
}
