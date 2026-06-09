// /app/src/app/(dashboard)/app/sales/import-hd/page.tsx
//
// Import Hunter Douglas proposal — App Router port of the legacy sales/import-hd.
// Any signed-in user (mirrors the legacy withAuth() with no roles). Posts to the
// shared /api/sales/import-hd-proposal REST endpoint, which stays REST. Chrome
// from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { ImportHdView } from "./ImportHdView";

export default async function ImportHdPage() {
  await requirePage();
  return <ImportHdView />;
}
