// /app/src/app/(dashboard)/app/admin/setup/database/page.tsx
//
// Database Backup & Restore -- App Router port of the legacy
// admin/setup/database. ADMIN only (mirrors the legacy withAuth roles). Reads
// the shared /api/admin/database/{backup,restore} REST endpoints. Chrome from
// the (dashboard) layout. On a practice copy, also saving its starting point and
// going back to it (GAP-28), for whoever may run the destructive routes beside it.

import { requirePage } from "@/lib/auth/requirePage";
import { getBusinessTimeZone } from "@/lib/appSettings";
import { isPracticeCopy } from "@/lib/practiceCopy";
import { readStartingPoint } from "@/lib/practiceCopyDatabase";
import { DatabaseBackupView } from "./DatabaseBackupView";
import { PracticeCopyCard } from "./PracticeCopyCard";

async function startingPointLabel(): Promise<string | null> {
  const savedAt = await readStartingPoint(process.env.DATABASE_URL as string);
  if (!savedAt) return null;
  return savedAt.toLocaleString("en-US", {
    timeZone: await getBusinessTimeZone(),
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default async function DatabaseBackupPage() {
  const { holds } = await requirePage(undefined, {
    permission: "admin.config",
    also: ["admin.data"],
  });
  const practice = isPracticeCopy() && holds["admin.data"];
  return (
    <>
      {practice ? <PracticeCopyCard savedOn={await startingPointLabel()} /> : null}
      <DatabaseBackupView />
    </>
  );
}
