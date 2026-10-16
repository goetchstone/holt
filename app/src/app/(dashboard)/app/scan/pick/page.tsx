// /app/src/app/(dashboard)/app/scan/pick/page.tsx
//
// Pick, stage and load a delivery run on a handheld (ledger plan phase 19).

import { requirePage } from "@/lib/auth/requirePage";
import { PickView } from "./PickView";

export default async function ScanPickPage() {
  await requirePage(undefined, { permission: "warehouse.operate" });
  return <PickView />;
}
