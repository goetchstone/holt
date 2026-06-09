// /app/src/app/(dashboard)/app/inventory/reconcile-photos/page.tsx
//
// Reconcile Unidentified Photos — App Router port of the legacy
// inventory/reconcile-photos. Any signed-in user (legacy bare withAuth, no
// roles/feature). The view reads the shared /api/inventory/* + /api/products
// REST endpoints, which stay REST. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { ReconcilePhotosView } from "./ReconcilePhotosView";

export default async function ReconcilePhotosPage() {
  await requirePage();
  return <ReconcilePhotosView />;
}
