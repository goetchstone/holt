// /app/src/app/(dashboard)/app/service/page.tsx
//
// Service cases queue -- App Router port. Gated on the "dispatch" feature
// module (mirrors the legacy withAuth(undefined, { feature: "dispatch" })); any
// signed-in user when the module is on. Reads the shared /api/service/cases +
// settings + warehouse/locations + staff REST endpoints, which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { ServiceView } from "./ServiceView";

export default async function ServiceCasesPage() {
  await requirePage(undefined, { feature: "dispatch" });
  return <ServiceView />;
}
