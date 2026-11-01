// /app/src/app/(dashboard)/app/warehouse/set-aside/page.tsx
//
// Set aside (GAP-16): stock in quarantine -- damaged, a wrong item, an
// incomplete set -- and what to do with it: back on sale, or written off
// (lib/inventory/setAside.ts). The server page gates; the view lists and acts.

import { requirePage } from "@/lib/auth/requirePage";
import { SetAsideView } from "./SetAsideView";

export default async function SetAsidePage() {
  await requirePage(undefined, { permission: "inventory.read" });
  return <SetAsideView />;
}
