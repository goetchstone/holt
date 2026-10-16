// /app/src/app/(dashboard)/app/scan/move/page.tsx
//
// Put away and move on a handheld (ledger plan phase 18).

import { requirePage } from "@/lib/auth/requirePage";
import { MoveView } from "./MoveView";

export default async function ScanMovePage() {
  await requirePage(undefined, { permission: "inventory.transfer" });
  return <MoveView />;
}
