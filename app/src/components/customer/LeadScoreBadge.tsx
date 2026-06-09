// /app/src/components/customer/LeadScoreBadge.tsx
//
// Shows a simple lead score tier (Hot/Warm/Cool/New) as a colored badge.
// Safe for designers to see — reveals no underlying wealth data.

import type { LeadTier } from "@/lib/leadScore";

const TIER_CONFIG: Record<LeadTier, { label: string; className: string }> = {
  HOT: { label: "Hot Lead", className: "bg-red-100 text-red-700 border border-red-200" },
  WARM: { label: "Warm", className: "bg-amber-100 text-amber-700 border border-amber-200" },
  COOL: { label: "Cool", className: "bg-sh-blue/10 text-sh-blue border border-sh-blue/20" },
  NEW: { label: "New", className: "bg-sh-gray/10 text-sh-gray border border-sh-gray/20" },
};

interface Props {
  tier: LeadTier | null | undefined;
  // Show score number (ADMIN/MARKETING/MANAGER only)
  score?: number | null;
  // Hide the NEW tier (don't clutter UI for low-value leads)
  hideNew?: boolean;
}

export function LeadScoreBadge({ tier, score, hideNew = true }: Props) {
  if (!tier) return null;
  if (hideNew && tier === "NEW") return null;
  const { label, className } = TIER_CONFIG[tier];
  return (
    <span
      className={`text-xs font-semibold px-2 py-0.5 rounded-full ${className}`}
      title={score != null ? `Lead score: ${score}/100` : undefined}
    >
      {label}
      {score != null ? ` · ${score}` : ""}
    </span>
  );
}
