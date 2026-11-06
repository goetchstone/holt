// /app/src/app/layout.tsx
//
// App Router root layout. Runs alongside the Pages Router (pages/_app.tsx)
// during the incremental migration — each router wraps only its own routes.
// Branding is resolved server-side here (no per-page getServerSideProps needed
// in App Router) and handed to the client provider stack.

import type { Metadata } from "next";
import "@/styles/globals.css";
import { getAppSettings, getPublicBranding, themeToCssVars } from "@/lib/appSettings";
import { isPracticeCopy } from "@/lib/practiceCopy";
import { PracticeBanner } from "@/components/PracticeBanner";
import { Providers } from "./providers";

// Every screen renders per request, so a page built ahead of time can't miss the
// practice banner, which depends on the database this server runs on rather than
// the one the build saw. Almost every page was already dynamic; this adds the two
// that weren't, /portal/order and the not-found page.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const branding = await getPublicBranding();
  return {
    title: branding.appName,
    description: branding.tagline ?? undefined,
    icons: branding.faviconUrl ? { icon: branding.faviconUrl } : undefined,
  };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const [branding, settings] = await Promise.all([getPublicBranding(), getAppSettings()]);
  // Per-deployment palette: turn AppSettings.theme into :root CSS vars that
  // drive the sh-* brand tokens. Injected here so EVERY App Router route (the
  // public site + back-office) is themeable -- previously this only ran in the
  // Pages-router _document, so App Router routes ignored the configured theme.
  const themeCss = themeToCssVars(settings.theme);
  return (
    <html lang="en">
      {themeCss ? (
        <head>
          <style dangerouslySetInnerHTML={{ __html: themeCss }} />
        </head>
      ) : null}
      <body>
        {isPracticeCopy() ? <PracticeBanner /> : null}
        <Providers branding={branding}>{children}</Providers>
      </body>
    </html>
  );
}
