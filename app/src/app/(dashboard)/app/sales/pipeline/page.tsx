// /app/src/app/(dashboard)/app/sales/pipeline/page.tsx
//
// Quote pipeline board (per-staff / all-staff scope, urgency buckets, follow-up
// logging, archive/restore, leads) -- App Router port of the legacy
// pages/sales/pipeline.tsx. Any signed-in user (mirrors the legacy bare
// withAuth() with no roles/feature); the all-staff scope + bulk-archive controls
// are gated client-side by the API's canViewAll flag exactly as before. Reads +
// writes the shared /api/sales/pipeline + /api/sales/interactions REST
// endpoints, which all stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { PipelineView } from "./PipelineView";

export default async function PipelinePage() {
  await requirePage();
  return <PipelineView />;
}
