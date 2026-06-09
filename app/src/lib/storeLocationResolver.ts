// /app/src/lib/storeLocationResolver.ts
//
// Maps store location name strings (from the POS imports, up-board, etc.)
// to StoreLocation IDs. Matches against both StoreLocation.name and
// StoreLocation.externalLocationName, case-insensitive.

import { prisma } from "@/lib/prisma";

let cachedMap: Map<string, number> | null = null;
let cacheExpiry = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Builds a lookup map from all active store locations. Keys are lowercased
// name and externalLocationName entries; values are StoreLocation IDs.
export async function buildLocationMap(tx?: any): Promise<Map<string, number>> {
  const db = tx || prisma;
  const locations = await db.storeLocation.findMany({
    where: { isActive: true },
    select: { id: true, name: true, externalLocationName: true },
  });

  const map = new Map<string, number>();
  for (const loc of locations) {
    map.set(loc.name.toLowerCase(), loc.id);
    if (loc.externalLocationName) {
      map.set(loc.externalLocationName.toLowerCase(), loc.id);
    }
  }
  return map;
}

// Returns a cached location map, refreshing every 5 minutes.
export async function getLocationMap(): Promise<Map<string, number>> {
  const now = Date.now();
  if (cachedMap && now < cacheExpiry) return cachedMap;

  cachedMap = await buildLocationMap();
  cacheExpiry = now + CACHE_TTL;
  return cachedMap;
}

// Resolves a store location name string to a StoreLocation ID.
// Returns null if no match found.
export async function resolveStoreLocationId(
  name: string | null | undefined,
): Promise<number | null> {
  if (!name) return null;
  const map = await getLocationMap();
  return map.get(name.toLowerCase()) ?? null;
}

// Clears the cached map. Call after creating or modifying store locations.
export function clearLocationCache(): void {
  cachedMap = null;
  cacheExpiry = 0;
}
