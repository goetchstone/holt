// /app/src/app/(dashboard)/app/admin/accounting/journal-entries/page.tsx
//
// Sales Journal Entries -- App Router page-only port of the legacy
// admin/accounting/journal-entries. MANAGER / ADMIN (mirrors the legacy withAuth
// roles). Generates, posts, exports, and reconciles daily sales journal entries
// via the shared /api/accounting/journal-entries REST endpoints, which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { JournalEntriesView } from "./JournalEntriesView";

export default async function JournalEntriesPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <JournalEntriesView />;
}
