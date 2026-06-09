// /app/src/app/(dashboard)/app/admin/pricing/style-editor/page.tsx
//
// Style Editor -- App Router port of the legacy admin/pricing/style-editor.
// MANAGER / ADMIN (mirrors the legacy withAuth roles). Browse, search, and
// correct imported VendorStyle data against the shared /api/pricing/products
// REST endpoint, editing rows via StyleEditModal. The REST endpoints stay REST.
// Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { StyleEditorView } from "./StyleEditorView";

export default async function PricingStyleEditorPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <StyleEditorView />;
}
