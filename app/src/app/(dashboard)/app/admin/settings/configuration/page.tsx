// /app/src/app/(dashboard)/app/admin/settings/configuration/page.tsx
//
// Configuration -- ADMIN only (mirrors Settings' own gate, same pattern as
// ./integrations/page.tsx). The GUI half of the config-preset system
// (docs/domains/config-presets.md): a peer of config/**/*.{yaml,json}, not a
// lesser view of it -- same schema, same rows, exports back to a file.

import { requirePage } from "@/lib/auth/requirePage";
import { ConfigurationView } from "./ConfigurationView";

export default async function ConfigurationPage() {
  await requirePage(["ADMIN"]);
  return <ConfigurationView />;
}
