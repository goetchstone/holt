"use client";

// /app/src/app/(dashboard)/app/admin/settings/configuration/ApplyPreview.tsx
//
// Renders the per-preset result list from POST .../apply -- shared by every
// write path on this page (Traffic Store Mapping, Import Definitions, and
// the Import & Export panel), since all three funnel through the same
// dry-run-then-confirm flow and the result shape is identical either way.
// This is the "show the diff" half of "dry run must be the default
// affordance -- show the diff, then let the operator confirm."

import { Badge, type BadgeVariant } from "@/components/ui/badge";
import type { ApplyResultSummary } from "@/lib/config/presetApiTypes";

const ACTION_VARIANT: Record<ApplyResultSummary["action"], BadgeVariant> = {
  APPLIED: "success",
  UNCHANGED: "neutral",
  FAILED: "danger",
};

export function ApplyPreview({ results }: Readonly<{ results: ApplyResultSummary[] }>) {
  if (results.length === 0) {
    return <p className="text-sm text-sh-gray">Nothing to apply.</p>;
  }

  return (
    <ul className="space-y-3">
      {results.map((r) => (
        <li
          key={`${r.kind}/${r.name}`}
          className="rounded-md border border-sh-brand-gray p-3 text-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-sh-black">
              {r.kind}/{r.name}
            </span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-sh-gray">
                +{r.changes.created} created &middot; {r.changes.updated} updated &middot; -
                {r.changes.deleted} deleted
              </span>
              <Badge variant={ACTION_VARIANT[r.action]}>{r.action}</Badge>
            </div>
          </div>
          {r.messages.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-sh-gray">
              {r.messages.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
