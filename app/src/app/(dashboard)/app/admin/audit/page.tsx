// /app/src/app/(dashboard)/app/admin/audit/page.tsx
//
// Audit Trail (GAP-29): who did what across the store. The filter lives in the URL,
// so a search can be sent to someone, and the page needs no script of its own.

import { requirePage } from "@/lib/auth/requirePage";
import { getAppSettings } from "@/lib/appSettings";
import { auditFilterFrom, loadAuditFeed } from "@/lib/auditFeed";
import { AuditTrailView } from "./AuditTrailView";

export default async function AuditTrailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePage(undefined, { permission: "admin.audit" });
  const filter = auditFilterFrom(await searchParams);
  const app = await getAppSettings();
  const feed = await loadAuditFeed(filter, app);
  return (
    <AuditTrailView feed={feed} filter={filter} timezone={app.timezone} locale={app.locale} />
  );
}
