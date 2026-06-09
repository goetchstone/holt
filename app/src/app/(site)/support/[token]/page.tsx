// /app/src/app/(site)/support/[token]/page.tsx
//
// Public, no-login ticket status view keyed by the ticket's publicToken.
// Feature-gated behind "helpdesk". Marked noindex -- these are per-request
// private links, not content we want crawled.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAppSettings } from "@/lib/appSettings";
import { isFeatureEnabled } from "@/lib/featureCatalog";
import { TicketStatusView } from "./TicketStatusView";

export const metadata: Metadata = { title: "Your request", robots: { index: false } };

export default async function SupportStatusPage({
  params,
}: Readonly<{ params: Promise<{ token: string }> }>) {
  const settings = await getAppSettings();
  if (!isFeatureEnabled(settings.features, "helpdesk")) notFound();
  const { token } = await params;

  return (
    <div className="mx-auto max-w-screen-md px-6 py-12">
      <TicketStatusView token={token} />
    </div>
  );
}
