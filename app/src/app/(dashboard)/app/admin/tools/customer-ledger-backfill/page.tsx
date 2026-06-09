// /app/src/app/(dashboard)/app/admin/tools/customer-ledger-backfill/page.tsx
//
// Customer Ledger Backfill -- App Router port. ADMIN only (mirrors the legacy
// withAuth roles). Reads the shared /api/admin/customer-ledger/customer-ids +
// /api/admin/customer-ledger/backfill REST endpoints. Chrome from the
// (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { CustomerLedgerBackfillView } from "./CustomerLedgerBackfillView";

export default async function CustomerLedgerBackfillPage() {
  await requirePage(["ADMIN"]);
  return <CustomerLedgerBackfillView />;
}
