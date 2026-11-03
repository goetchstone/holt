// /app/src/app/(dashboard)/app/admin/setup/customer-messages/page.tsx
//
// Settings -> Customer messages (GAP-13): the messages Holt sends a customer
// by itself, each switched on or off with the store's own wording and timing.
// Gated on admin.settings, the key /api/customer-messages saves with. Chrome
// from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { getAppSettings } from "@/lib/appSettings";
import { CustomerMessagesView } from "./CustomerMessagesView";

export default async function CustomerMessagesPage() {
  await requirePage(undefined, { permission: "admin.settings" });
  const { companyName, appName, timezone } = await getAppSettings();
  return <CustomerMessagesView storeName={companyName?.trim() || appName} timeZone={timezone} />;
}
