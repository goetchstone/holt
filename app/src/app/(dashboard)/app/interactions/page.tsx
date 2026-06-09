// /app/src/app/(dashboard)/app/interactions/page.tsx
//
// Customer interactions list -- App Router port. Any signed-in user (matches the
// legacy bare withAuth() gate). Reads the shared /api/interactions + /api/staff
// REST endpoints; those stay REST. The page is gated server-side.

import { requirePage } from "@/lib/auth/requirePage";
import { InteractionsView } from "./InteractionsView";

export default async function InteractionsPage() {
  await requirePage();
  return <InteractionsView />;
}
