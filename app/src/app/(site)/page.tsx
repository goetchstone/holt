// /app/src/app/(site)/page.tsx
//
// Public site home at "/". Renders the published home page from the CMS when
// one exists; otherwise shows the deployment's branded default landing (a real
// empty state driven by AppSettings, not a placeholder).

import type { Metadata } from "next";
import Link from "next/link";
import { getAppSettings } from "@/lib/appSettings";
import { getHomePage, siteUrl } from "@/lib/cms/queries";
import { BlockRenderer } from "@/components/cms/BlockRenderer";

export async function generateMetadata(): Promise<Metadata> {
  const [settings, home] = await Promise.all([getAppSettings(), getHomePage()]);
  const title = home?.seoTitle || settings.appName;
  const description = home?.seoDescription || settings.tagline || undefined;
  return {
    title,
    description,
    alternates: { canonical: siteUrl() },
    openGraph: { title, description, url: siteUrl(), type: "website", siteName: settings.appName },
  };
}

export default async function SiteHome() {
  const home = await getHomePage();
  if (home && home.blocks.length > 0) {
    return <BlockRenderer blocks={home.blocks} />;
  }

  const settings = await getAppSettings();
  return (
    <section className="mx-auto flex min-h-[60vh] max-w-screen-lg flex-col items-center justify-center px-6 text-center">
      <h1 className="font-serif text-4xl text-sh-navy sm:text-5xl">{settings.appName}</h1>
      {settings.tagline ? (
        <p className="mt-4 max-w-xl text-lg text-sh-gray">{settings.tagline}</p>
      ) : null}
      <Link
        href="/app"
        className="mt-10 rounded-md bg-sh-navy px-6 py-3 text-sm font-medium text-white transition hover:bg-sh-blue"
      >
        Staff sign in
      </Link>
    </section>
  );
}
