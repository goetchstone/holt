// /app/src/app/(dashboard)/app/admin/diagnostics/lookup-test/page.tsx
//
// Diagnostic Lookup Tool -- App Router port of the legacy
// admin/diagnostics/lookup-test. MANAGER / ADMIN (mirrors the legacy withAuth
// roles). Posts to the shared /api/diagnostics/lookup-test REST endpoint. Chrome
// from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { LookupTestView } from "./LookupTestView";

export default async function LookupTestPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <LookupTestView />;
}
