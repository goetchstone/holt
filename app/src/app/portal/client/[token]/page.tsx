// /app/src/app/portal/client/[token]/page.tsx
//
// Consultancy client portal hub — public, no login: the URL carries a
// customer-scoped capability token (lib/clientPortalToken.ts, 30-day JWT).
// Server-rendered: token verified + data loaded here; the only client-side
// interaction is the invoice pay button (POST /api/client-portal/pay).
// 404 when the clientPortal feature is off or the token is invalid/expired —
// indistinguishable from a wrong URL on purpose.

export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getAppSettings } from "@/lib/appSettings";
import { isFeatureEnabled } from "@/lib/featureCatalog";
import { verifyClientPortalToken } from "@/lib/clientPortalToken";
import { getClientPortalData } from "@/lib/clientPortal";
import { ClientPortalView } from "./ClientPortalView";

export default async function ClientPortalPage({ params }: { params: Promise<{ token: string }> }) {
  const settings = await getAppSettings();
  if (!isFeatureEnabled(settings.features, "clientPortal")) notFound();

  const { token } = await params;
  const payload = verifyClientPortalToken(token);
  if (!payload) notFound();

  const data = await getClientPortalData(payload.customerId);
  if (!data) notFound();

  return (
    <ClientPortalView
      token={token}
      data={data}
      appName={settings.companyName?.trim() || settings.appName}
      currency={settings.currency || "USD"}
      locale={settings.locale || "en-US"}
    />
  );
}
