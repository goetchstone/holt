// /app/src/app/(dashboard)/app/scan/lookup/page.tsx
//
// Scan anything and see what it is and where it is (ledger plan phase 15).

import { requirePage } from "@/lib/auth/requirePage";
import { LookupView } from "./LookupView";

export default async function ScanLookupPage() {
  await requirePage(undefined, { permission: "inventory.read" });
  return <LookupView />;
}
