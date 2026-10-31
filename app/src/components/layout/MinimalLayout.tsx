// /app/src/components/layout/MinimalLayout.tsx

import Head from "next/head";
import { ReactNode } from "react";
import { BrandLogo } from "@/components/branding/BrandLogo";
import { useSession } from "next-auth/react";
import { signOutTo } from "@/lib/auth/endSession";
import { Button } from "@/components/ui/button";
import { useBranding } from "@/components/branding/BrandingProvider";

interface MinimalLayoutProps {
  children: ReactNode;
  title?: string;
}

export default function MinimalLayout({ children, title }: MinimalLayoutProps) {
  const { data: session } = useSession();
  const branding = useBranding();

  const handleSignOut = async () => {
    await signOutTo("/auth/login");
  };

  return (
    <>
      {title && (
        <Head>
          <title>{title}</title>
        </Head>
      )}
      <header className="w-full border-b border-brand-gray bg-white px-8 h-16 flex items-center justify-between shadow-sm">
        <div className="flex-1"></div>
        <div className="flex-1 flex justify-center">
          <BrandLogo
            appName={branding.appName}
            logoUrl={branding.logoUrl}
            width={48}
            height={48}
            className="rounded object-contain"
          />
        </div>
        <div className="flex-1 flex justify-end">
          {session && (
            <Button variant="outline" onClick={handleSignOut}>
              Sign Out
            </Button>
          )}
        </div>
      </header>
      <main className="p-4 mx-auto max-w-screen-lg">{children}</main>
    </>
  );
}
