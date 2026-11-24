// /app/src/app/(dashboard)/app/dispatch/driver/page.tsx
//
// Driver delivery view (focused mobile screen for the active run) -- App Router
// port. "Operate warehouse" (warehouse.operate), the key of every /api/dispatch
// route it calls. Reads the shared /api/dispatch/* REST endpoints, which stay
// REST.

import { requirePage } from "@/lib/auth/requirePage";
import { DriverView } from "./DriverView";

export default async function DriverPage() {
  await requirePage(undefined, { permission: "warehouse.operate" });
  return <DriverView />;
}
