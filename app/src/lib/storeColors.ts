// /app/src/lib/storeColors.ts
//
// Consistent color palette for store-level charts. Colors are assigned
// by index so new stores automatically get a color without code changes.
//
// This file stays client-safe (it's imported by "use client" chart
// components) and therefore holds ONLY the color palette. Traffic-counter
// display-name / StoreLocation mapping used to live here as hardcoded
// object literals (STORE_DISPLAY_NAMES / AXPER_TO_STORE_LOCATION); that is
// now database-backed via StoreLocation.trafficSourceNames, resolved by the
// server-only lib/trafficStoreMap.ts (Prisma-touching, so it cannot live in
// this file).

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
 * Returns a consistent background color for a store based on its index.
 */
export function getStoreColor(index: number, variant: "solid" | "light" = "solid"): string {
  const palette = variant === "light" ? STORE_COLORS_LIGHT : STORE_COLORS;
  return palette[index % palette.length];
}
