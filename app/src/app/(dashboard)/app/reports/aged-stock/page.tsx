// /app/src/app/(dashboard)/app/reports/aged-stock/page.tsx
//
// Aged Stock: how long uncommitted stock has been here (lib/reports/agedStock.ts).
// MANAGER/ADMIN, like Inventory Health; the client view reads it over tRPC.

import { requirePage } from "@/lib/auth/requirePage";
import { AgedStockView } from "./AgedStockView";

export default async function AgedStockPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <AgedStockView />;
}
