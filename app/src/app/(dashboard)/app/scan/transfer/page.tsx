// /app/src/app/(dashboard)/app/scan/transfer/page.tsx
//
// Send and receive transfers on a handheld (GAP-19), on the key the desk's
// transfers take.

import { requirePage } from "@/lib/auth/requirePage";
import { TransferView } from "./TransferView";

export default async function ScanTransferPage() {
  await requirePage(undefined, { permission: "inventory.transfer" });
  return <TransferView />;
}
