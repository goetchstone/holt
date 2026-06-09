// /app/src/app/(dashboard)/app/service/cases/new/page.tsx
//
// New service case form -- App Router port. Any signed-in user (mirrors the
// legacy bare withAuth() gate). Reads the shared /api/service/cases + settings +
// staff + warehouse/locations + sales/orders REST endpoints, which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { NewServiceCaseView } from "./NewServiceCaseView";

export default async function NewServiceCasePage() {
  await requirePage();
  return <NewServiceCaseView />;
}
