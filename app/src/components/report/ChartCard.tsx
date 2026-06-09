// /app/src/components/report/ChartCard.tsx
//
// Consistent wrapper for Chart.js charts across all report pages.
// Handles title, loading state, and empty state so each chart page
// doesn't need to repeat that chrome.

import { ReactNode } from "react";

interface ChartCardProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  loading?: boolean;
  empty?: boolean;
  emptyMessage?: string;
  // Optional action element (e.g., a toggle or filter) shown in the header
  action?: ReactNode;
}

export function ChartCard({
  title,
  subtitle,
  children,
  loading,
  empty,
  emptyMessage = "No data for this period.",
  action,
}: ChartCardProps) {
  return (
    <div className="bg-white rounded-xl border border-sh-gray/15 shadow-sm p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-sh-black font-serif text-base">{title}</h3>
          {subtitle && <p className="text-xs text-sh-gray mt-0.5 font-sans">{subtitle}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>

      {loading ? (
        <div className="h-48 flex items-center justify-center text-sh-gray text-sm font-sans animate-pulse">
          Loading...
        </div>
      ) : empty ? (
        <div className="h-48 flex items-center justify-center text-sh-gray text-sm font-sans">
          {emptyMessage}
        </div>
      ) : (
        children
      )}
    </div>
  );
}
