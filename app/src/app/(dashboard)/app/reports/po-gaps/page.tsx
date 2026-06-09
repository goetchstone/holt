// /app/src/app/(dashboard)/app/reports/po-gaps/page.tsx
//
// Open PO Gaps — App Router port. ADMIN only, one-shot: the server component
// gates, fetches via the shared lib, and hands the result to the client view,
// which filters in memory. Chrome from the (dashboard) layout.

import { prisma } from "@/lib/prisma";
import { requirePage } from "@/lib/auth/requirePage";
import { getPoGaps } from "@/lib/reports/poGaps";
import { PoGapsView } from "./PoGapsView";

export default async function PoGapsPage() {
  await requirePage(["ADMIN"]);
  const data = await getPoGaps(prisma);
  return <PoGapsView data={data} />;
}
