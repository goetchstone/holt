// /app/src/app/(dashboard)/app/tools/legacy-archive/page.tsx
//
// Legacy Archive lookup — read-only search over sales history imported from a
// previous system. Any signed-in staff (parity with the Tools hub); 404 when
// the legacyArchive feature is off.

import { requirePage } from "@/lib/auth/requirePage";
import { requireModule } from "@/lib/modules/requireModule";
import { LegacyArchiveView } from "./LegacyArchiveView";

export default async function LegacyArchivePage() {
  await requirePage();
  await requireModule("legacyArchive");
  return <LegacyArchiveView />;
}
