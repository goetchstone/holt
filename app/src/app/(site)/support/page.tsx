// /app/src/app/(site)/support/page.tsx
//
// Public support page (slug /support). Feature-gated behind "helpdesk" -- 404s
// when the module is off. Server component resolves branding for the heading +
// metadata; the client SupportFormView submits over the public /api/tickets API.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAppSettings } from "@/lib/appSettings";
import { isFeatureEnabled } from "@/lib/featureCatalog";
import { SupportFormView } from "./SupportFormView";

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getAppSettings();
  return {
    title: `Support | ${settings.appName}`,
    description: `Get help from the ${settings.companyName?.trim() || settings.appName} team.`,
  };
}

export default async function SupportPage() {
  const settings = await getAppSettings();
  if (!isFeatureEnabled(settings.features, "helpdesk")) notFound();
  const teamName = settings.companyName?.trim() || settings.appName;

  return (
    <div className="mx-auto max-w-screen-md px-6 py-12">
      <header className="max-w-2xl">
        <h1 className="font-serif text-4xl text-sh-navy">How can we help?</h1>
        <p className="mt-3 text-sh-gray">
          Send the {teamName} team a message and we&apos;ll get back to you by email. You&apos;ll
          get a link to track your request.
        </p>
      </header>
      <SupportFormView />
    </div>
  );
}
