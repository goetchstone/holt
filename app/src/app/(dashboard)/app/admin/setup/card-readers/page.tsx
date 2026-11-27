// /app/src/app/(dashboard)/app/admin/setup/card-readers/page.tsx
//
// Admin > Setup > Card readers: register a reader with the card processor and
// say which register it sits at. Reads and writes /api/card-readers.

import { requirePage } from "@/lib/auth/requirePage";
import { CardReadersView } from "./CardReadersView";

export default async function CardReadersPage() {
  await requirePage(undefined, { permission: "admin.config" });
  return <CardReadersView />;
}
