// /app/src/app/(site)/book/page.tsx
//
// Public "Book a consultation" page (slug /book). Server component: resolves
// branding for the heading + metadata, then renders the client BookingView,
// which does all DB-backed work (availability + create) over the public API.
// No DB access here, so nothing is prerendered from the database; the (site)
// layout's force-dynamic still applies to the route.

import type { Metadata } from "next";
import { getAppSettings } from "@/lib/appSettings";
import { BookingView } from "./BookingView";

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getAppSettings();
  return {
    title: `Book a consultation | ${settings.appName}`,
    description: `Schedule a consultation with ${settings.companyName?.trim() || settings.appName}.`,
  };
}

export default async function BookPage() {
  const settings = await getAppSettings();
  const studioName = settings.companyName?.trim() || settings.appName;

  return (
    <div className="mx-auto max-w-screen-lg px-6 py-12">
      <header className="max-w-2xl">
        <h1 className="font-serif text-4xl text-sh-navy">Book a consultation</h1>
        <p className="mt-3 text-sh-gray">
          Pick a time that works for you and we&apos;ll confirm your appointment with {studioName}.
          You&apos;ll get a calendar invite you can add to any calendar.
        </p>
      </header>
      <BookingView />
    </div>
  );
}
