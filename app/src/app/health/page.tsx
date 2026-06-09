// /app/src/app/health/page.tsx
//
// Smoke route proving the App Router shell renders alongside the Pages Router.
// Server component: resolves branding server-side to confirm the server-data
// path works end-to-end. Reachable at /health. Removed once real App Router
// routes exist; for now it's the F2 foundation check.

import { getPublicBranding } from "@/lib/appSettings";
import { HealthPing } from "./HealthPing";

export default async function HealthPage() {
  const branding = await getPublicBranding();
  return (
    <main className="mx-auto max-w-screen-lg px-4 py-10 font-serif">
      <h1 className="text-2xl font-semibold text-sh-navy">App Router is live</h1>
      <p className="mt-2 text-sh-gray">
        {branding.appName} foundation OK — App Router and Pages Router are running side-by-side.
      </p>
      <HealthPing />
    </main>
  );
}
