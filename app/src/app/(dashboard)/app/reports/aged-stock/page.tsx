// /app/src/app/(dashboard)/app/reports/aged-stock/page.tsx
//
// Aged Stock: how long uncommitted stock has been here (lib/reports/agedStock.ts).
// "View management reports", like Inventory Health; the client view reads it
// over tRPC.

import { requirePage } from "@/lib/auth/requirePage";
import { AgedStockView } from "./AgedStockView";

export default async function AgedStockPage() {
  await requirePage(undefined, { permission: "reporting.management" });
  return <AgedStockView />;
}
