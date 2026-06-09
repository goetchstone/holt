// /app/src/components/layout/MainLayout.tsx

import Head from "next/head";
import { ReactNode } from "react";
import TopNav from "@/components/navigation/TopNav";
import { PRODUCT } from "@/lib/branding";

interface MainLayoutProps {
  children: ReactNode;
  title?: string;
}

export default function MainLayout({ children, title }: MainLayoutProps) {
  return (
    <div className="flex min-h-screen flex-col">
      {title && (
        <Head>
          <title>{title}</title>
        </Head>
      )}
      <TopNav />
      {/* Enforce consistent max-width and centering for all content within MainLayout */}
      <main className="p-4 mx-auto w-full max-w-screen-lg flex-1">{children}</main>
      {PRODUCT.attribution ? (
        <footer className="mx-auto w-full max-w-screen-lg px-4 py-4 text-center text-xs text-sh-gray/60">
          <a
            href={PRODUCT.makerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-sh-gray"
          >
            {PRODUCT.attribution}
          </a>
        </footer>
      ) : null}
    </div>
  );
}
