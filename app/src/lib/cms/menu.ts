// /app/src/lib/cms/menu.ts
//
// Shared client/server contract (CLAUDE.md rule 7) for navigation menus.
// Menu.items is stored as a typed JSON array consumed by the public header /
// footer and edited in the admin Menus screen. One level of nesting is
// supported (children) for dropdowns.

import { z } from "zod";

export const MENU_LOCATIONS = ["header", "footer"] as const;
export type MenuLocation = (typeof MENU_LOCATIONS)[number];

// Children are intentionally one level deep. Declared via an explicit child
// schema (no recursion) so the type stays simple and the public nav renders
// header > dropdown without unbounded depth.
export const menuChildSchema = z.object({
  label: z.string().default(""),
  href: z.string().default(""),
});

export const menuItemSchema = z.object({
  label: z.string().default(""),
  href: z.string().default(""),
  children: z.array(menuChildSchema).default([]),
});

export type MenuChild = z.infer<typeof menuChildSchema>;
export type MenuItem = z.infer<typeof menuItemSchema>;

export const menuItemsSchema = z.array(menuItemSchema);

/**
 * Parse a stored menu items value (Prisma Json, possibly null) into a
 * validated array. Invalid or null input yields an empty array.
 */
export function parseMenuItems(value: unknown): MenuItem[] {
  if (value == null) return [];
  const result = menuItemsSchema.safeParse(value);
  return result.success ? result.data : [];
}
