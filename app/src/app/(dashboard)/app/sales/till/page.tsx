// /app/src/app/(dashboard)/app/sales/till/page.tsx
//
// Till open/close register flow (per-store register list, denomination counts,
// open-till summaries, close-out, recent history) -- App Router port of the
// legacy pages/sales/till.tsx. Any signed-in user (mirrors the legacy bare
// withAuth() with no roles/feature). Reads + writes the shared /api/registers,
// /api/tills REST endpoints, which all stay REST. The one-till detail route
// lives at /sales/till/[id] -- nested under this list path, no collision.

import { requirePage } from "@/lib/auth/requirePage";
import { TillView } from "./TillView";

export default async function TillPage() {
  await requirePage(undefined, { feature: "tills" });
  return <TillView />;
}
