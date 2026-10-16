// /app/src/app/(dashboard)/app/scan/count/page.tsx
//
// Count one place on a handheld (ledger plan phase 17).

import { requirePage } from "@/lib/auth/requirePage";
import { CountView } from "./CountView";

export default async function ScanCountPage() {
  await requirePage(undefined, { permission: "inventory.count" });
  return <CountView />;
}
