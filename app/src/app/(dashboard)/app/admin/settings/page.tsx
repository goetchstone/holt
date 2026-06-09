// /app/src/app/(dashboard)/app/admin/settings/page.tsx
//
// Settings -- App Router page-only port of the legacy admin/settings. ADMIN only
// (mirrors the legacy withAuth roles). Branding, theme colors, localization,
// feature modules, and encrypted integration credentials (with per-provider Test
// Connection) via the shared /api/admin/settings REST endpoints, which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { SettingsView } from "./SettingsView";

export default async function SettingsPage() {
  await requirePage(["ADMIN"]);
  return <SettingsView />;
}
