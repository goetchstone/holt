// /app/src/app/(dashboard)/app/admin/gift-cards/import/page.tsx
//
// Gift Card voucher import -- App Router page-only port of the legacy
// admin/gift-cards/import. MANAGER / ADMIN (mirrors the legacy withAuth roles).
// Parses the CSV client-side and posts to the shared /api/gift-cards/import REST
// endpoint, which stays REST. Nested under the gift-cards list -- distinct path.

import { requirePage } from "@/lib/auth/requirePage";
import { GiftCardImportView } from "./GiftCardImportView";

export default async function GiftCardImportPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <GiftCardImportView />;
}
