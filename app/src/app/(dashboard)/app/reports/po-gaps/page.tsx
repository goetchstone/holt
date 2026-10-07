// /app/src/app/(dashboard)/app/reports/po-gaps/page.tsx
//
// Open PO Gaps — App Router port. ADMIN only (and answers "View cost"),
// one-shot: the server component gates, fetches via the shared lib, and hands
// the result to the client view, which filters in memory. Chrome from the
// (dashboard) layout.

import { prisma } from "@/lib/prisma";
import { requirePage } from "@/lib/auth/requirePage";
import { canViewCost, WITH_COST } from "@/lib/auth/costVisibility";
import { getPoGaps, poGapsForCaller } from "@/lib/reports/poGaps";
import { PoGapsView } from "./PoGapsView";

export default async function PoGapsPage() {
  const { holds } = await requirePage(["ADMIN"], WITH_COST);
  // Each PO's cost only for a holder of "View cost"; stripped here, on the
  // server, so it never reaches anyone else's browser.
  const data = poGapsForCaller(await getPoGaps(prisma), canViewCost({ holds }));
  return <PoGapsView data={data} />;
}
