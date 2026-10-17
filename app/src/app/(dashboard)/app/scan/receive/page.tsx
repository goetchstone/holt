// /app/src/app/(dashboard)/app/scan/receive/page.tsx
//
// Receive against a purchase order on a handheld (ledger plan phase 16).

import { requirePage } from "@/lib/auth/requirePage";
import { ReceiveView } from "./ReceiveView";

export default async function ScanReceivePage() {
  await requirePage(undefined, { permission: "purchasing.receive" });
  return <ReceiveView />;
}
