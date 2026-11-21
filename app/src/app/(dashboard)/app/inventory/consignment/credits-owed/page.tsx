// /app/src/app/(dashboard)/app/inventory/consignment/credits-owed/page.tsx
//
// Credits Owed — App Router port of the legacy
// inventory/consignment/credits-owed. On "View accounting", the key of its
// sibling consignor-payout screens, Payments (which links here) and Unpaid
// Sales. Reads the shared /api/consignment/credits-owed REST endpoint, which
// stays REST and is on "Write purchase orders"; every built-in role with View
// accounting holds that too.

import { requirePage } from "@/lib/auth/requirePage";
import { CreditsOwedView } from "./CreditsOwedView";

export default async function CreditsOwedPage() {
  await requirePage(undefined, { permission: "accounting.read" });
  return <CreditsOwedView />;
}
