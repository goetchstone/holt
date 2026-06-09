// /app/src/components/ui/badge.tsx
//
// Status pill. Replaces the per-page hand-rolled `<span className="rounded ...">`
// status chips so every status reads the same across the app. Semantic variants
// map to the brand + standard success/warning/danger colors.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const VARIANTS = {
  neutral: "bg-sh-stripe text-sh-gray",
  success: "bg-green-100 text-green-800",
  warning: "bg-sh-gold/20 text-sh-gold",
  danger: "bg-red-100 text-red-800",
  info: "bg-sh-brand-blue/15 text-sh-brand-blue",
} as const;

export type BadgeVariant = keyof typeof VARIANTS;

export function Badge({
  variant = "neutral",
  className,
  children,
}: {
  variant?: BadgeVariant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-2 py-0.5 text-xs font-medium",
        VARIANTS[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
