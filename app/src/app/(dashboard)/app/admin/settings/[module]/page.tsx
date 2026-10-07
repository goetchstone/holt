// /app/src/app/(dashboard)/app/admin/settings/[module]/page.tsx
//
// A single module's settings page, rendered generically from its manifest
// entry (lib/modules -- docs/domains/modules.md). ADMIN only, same as the
// rest of Settings. 404s when the key isn't a known module, the module is
// disabled, or it declares neither `settings` nor `nav` -- same rule the
// Settings overview uses to decide whether to link here in the first place,
// so a disabled (or never-enabled) module's page is unreachable by URL too.

import { notFound } from "next/navigation";
import { requirePage } from "@/lib/auth/requirePage";
import { getAppSettings } from "@/lib/appSettings";
import { getModule, isModuleSettingsRoutable } from "@/lib/modules";
import { ModuleSettingsView } from "./ModuleSettingsView";

export default async function ModuleSettingsPage({
  params,
}: Readonly<{ params: Promise<{ module: string }> }>) {
  await requirePage(undefined, { permission: "admin.settings" });
  const { module: moduleKey } = await params;

  const settings = await getAppSettings();
  if (!isModuleSettingsRoutable(settings.features, moduleKey)) notFound();

  const mod = getModule(moduleKey);
  if (!mod) notFound(); // unreachable given the check above; narrows the type

  return <ModuleSettingsView module={mod} />;
}
