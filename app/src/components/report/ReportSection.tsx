// /app/src/components/report/ReportSection.tsx
//
// Section divider used to visually group related metrics or tables
// within a report page. Keeps the hierarchy consistent.

import { ReactNode } from "react";

interface ReportSectionProps {
  title: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
}

export function ReportSection({ title, description, children, action }: ReportSectionProps) {
  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-3 border-b border-sh-gray/15 pb-2">
        <div>
          <h2 className="text-sm font-semibold text-sh-gray uppercase tracking-widest font-sans">
            {title}
          </h2>
          {description && <p className="text-xs text-sh-gray/70 mt-0.5 font-sans">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}
