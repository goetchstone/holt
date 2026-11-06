// /app/src/app/(dashboard)/app/admin/automations/page.tsx
//
// Admin > Automations (GAP-37): everything Holt does by itself, each switched on or off,
// with when it runs and how it last went. Gated on admin.automations, the key that runs
// them. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { loadAutomationsScreen } from "@/lib/automations/screen";
import { AutomationsView } from "./AutomationsView";

export default async function AutomationsPage() {
  await requirePage(undefined, { permission: "admin.automations" });
  const screen = await loadAutomationsScreen();
  return (
    <AutomationsView
      rows={JSON.parse(JSON.stringify(screen.rows))}
      notReady={screen.notReady}
      wokenAt={screen.wokenAt ? screen.wokenAt.toISOString() : null}
      wokenLate={screen.wokenLate}
      messages={screen.messages}
      timeZone={screen.timeZone}
      locale={screen.locale}
    />
  );
}
