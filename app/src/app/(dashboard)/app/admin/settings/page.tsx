// /app/src/app/(dashboard)/app/admin/settings/page.tsx
//
// Settings overview -- ADMIN only (mirrors the legacy withAuth roles).
// Branding, theme colors, localization, booking, and the module manifest's
// on/off grid + settings index. Integrations lives at ./integrations;
// per-module settings pages live at ./[module]. See docs/domains/modules.md.

import { requirePage } from "@/lib/auth/requirePage";
import { SettingsOverviewView } from "./SettingsOverviewView";

export default async function SettingsPage() {
  await requirePage(["ADMIN"]);
  return <SettingsOverviewView />;
}
