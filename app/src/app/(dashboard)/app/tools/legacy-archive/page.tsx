// /app/src/app/(dashboard)/app/tools/legacy-archive/page.tsx
//
// Legacy Archive lookup — read-only search over sales history imported from a
// previous system. Any signed-in staff (parity with the Tools hub); 404 when
// the legacyArchive feature is off.

import { notFound } from "next/navigation";
import { requirePage } from "@/lib/auth/requirePage";
import { getAppSettings } from "@/lib/appSettings";
import { isFeatureEnabled } from "@/lib/featureCatalog";
import { LegacyArchiveView } from "./LegacyArchiveView";

export default async function LegacyArchivePage() {
  await requirePage();
  const settings = await getAppSettings();
  if (!isFeatureEnabled(settings.features, "legacyArchive")) notFound();
  return <LegacyArchiveView />;
}
