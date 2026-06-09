// /app/src/app/(dashboard)/app/tools/configurator/page.tsx
//
// Product Configurator — App Router port. Any signed-in user (matches the legacy
// session-only gate). Reads the shared /api/vendors + /api/pricing/products REST
// endpoints. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { ConfiguratorView } from "./ConfiguratorView";

export default async function ConfiguratorPage() {
  await requirePage();
  return <ConfiguratorView />;
}
