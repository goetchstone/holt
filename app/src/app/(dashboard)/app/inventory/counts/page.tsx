// /app/src/app/(dashboard)/app/inventory/counts/page.tsx
//
// Counts by place (lib/inventory/count.ts): submitted counts with what
// posting each would move, to post or cancel, and the latest posted ones.

import { requirePage } from "@/lib/auth/requirePage";
import { CountsView } from "./CountsView";

export default async function CountsPage() {
  await requirePage(undefined, { permission: "inventory.count" });
  return <CountsView />;
}
