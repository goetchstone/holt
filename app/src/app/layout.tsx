// /app/src/app/layout.tsx
//
// App Router root layout. Runs alongside the Pages Router (pages/_app.tsx)
// during the incremental migration — each router wraps only its own routes.
// Branding is resolved server-side here (no per-page getServerSideProps needed
// in App Router) and handed to the client provider stack.

import type { Metadata } from "next";
import "@/styles/globals.css";
import { getAppSettings, getPublicBranding, themeToCssVars } from "@/lib/appSettings";
import { Providers } from "./providers";

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
        <Providers branding={branding}>{children}</Providers>
      </body>
    </html>
  );
}
