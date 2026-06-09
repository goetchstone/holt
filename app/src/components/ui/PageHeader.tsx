// /app/src/components/ui/PageHeader.tsx
//
// Standard page header for back-office pages: a serif title, optional subtitle,
// and an optional actions slot (buttons) on the right. Replaces the per-page
// ad-hoc <h1> patterns so every screen reads the same.

import type { ReactNode } from "react";

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-serif text-2xl font-semibold text-sh-navy">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-sh-gray">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
