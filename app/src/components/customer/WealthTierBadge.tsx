// /app/src/components/customer/WealthTierBadge.tsx
//
// Displays a color-coded wealth tier badge from Windfall enrichment data.
// Returns null for unknown or low tiers to keep the UI clean.

const TIER_CONFIG: Record<string, { label: string; className: string }> = {
  ULTRA_HIGH: { label: "$10M+", className: "bg-sh-gold/20 text-sh-gold" },
  VERY_HIGH: { label: "$5-10M", className: "bg-purple-100 text-purple-800" },
  HIGH: { label: "$1-5M", className: "bg-sh-blue/15 text-sh-blue" },
  AFFLUENT: { label: "$500K+", className: "bg-teal-100 text-teal-700" },
};

export function WealthTierBadge({ tier }: { tier: string | null | undefined }) {
  if (!tier || !TIER_CONFIG[tier]) return null;
  const { label, className } = TIER_CONFIG[tier];
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${className}`}>{label}</span>
  );
}
