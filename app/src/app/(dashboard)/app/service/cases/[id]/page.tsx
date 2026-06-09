// /app/src/app/(dashboard)/app/service/cases/[id]/page.tsx
//
// Service case detail -- App Router port. Any signed-in user (mirrors the legacy
// bare withAuth() gate). Reads the shared /api/service/cases/[id] + notes +
// tasks + staff + settings + sales/orders + purchasing/orders REST endpoints,
// which stay REST. In Next 16 `params` is a Promise, so it must be awaited
// before reading the dynamic id.

import { requirePage } from "@/lib/auth/requirePage";
import { CaseDetailView } from "./CaseDetailView";

export default async function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePage();
  return <CaseDetailView id={id} />;
}
