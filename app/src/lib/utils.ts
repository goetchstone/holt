// /app/src/lib/utils.ts
//
// cn(): merge conditional class names then de-conflict Tailwind utilities.
// Standard shadcn/ui helper used by every primitive in components/ui.

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
