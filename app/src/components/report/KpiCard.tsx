// /app/src/components/report/KpiCard.tsx
//
// Metric display card used across all report pages.
// Trend direction is context-aware: pass `positiveIsGood={false}` for metrics
// where an increase is bad (e.g., overdue orders, outstanding AR).

import { ReactNode } from "react";
import Link from "next/link";

interface KpiCardProps {
  label: string;
  value: string | number;
  // Formatted comparison value, e.g. "+$12,400 vs prior year"
  comparison?: string;
  // Positive = value went up vs comparison period
  trend?: "up" | "down" | "neutral";
  // When false, "up" is shown in red and "down" in green (e.g. overdue count)
  positiveIsGood?: boolean;
  sub?: ReactNode;
  // Optional link — makes the entire card clickable
  href?: string;
  // "compact" scales the numeric value down so big currency totals
  // ($14M+) fit inside a narrow card when 6+ KPIs are packed in a row.
  // Used by the Buyers Report; normal mode keeps the original sizing.
  size?: "normal" | "compact";
}

export function KpiCard({
  label,
  value,
  comparison,
  trend,
  positiveIsGood = true,
  sub,
  href,
  size = "normal",
}: KpiCardProps) {
  let trendColor = "text-sh-gray";
  let trendSymbol = "";

  if (trend === "up") {
    trendColor = positiveIsGood ? "text-green-600" : "text-red-600";
    trendSymbol = "↑";
  } else if (trend === "down") {
    trendColor = positiveIsGood ? "text-red-600" : "text-green-600";
    trendSymbol = "↓";
  }

  const card = (
    <div
      className={`bg-white rounded-xl border border-sh-gray/15 shadow-sm p-5${href ? " hover:border-sh-gold/40 transition-colors cursor-pointer" : ""}`}
    >
      <p className="text-xs text-sh-gray uppercase tracking-widest font-sans">{label}</p>
      <p
        className={`font-semibold text-sh-black font-serif mt-1 leading-none tabular-nums whitespace-nowrap overflow-hidden ${
          size === "compact" ? "text-base md:text-lg xl:text-xl" : "text-3xl"
        }`}
      >
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
      {comparison && (
        <p className={`text-xs mt-2 font-sans ${trendColor}`}>
          {trendSymbol && <span className="mr-0.5">{trendSymbol}</span>}
          {comparison}
        </p>
      )}
      {sub && <div className="mt-2 text-xs text-sh-gray font-sans">{sub}</div>}
    </div>
  );

  if (href) return <Link href={href}>{card}</Link>;
  return card;
}
