// /app/src/components/layout/ScannerLayout.tsx

import Head from "next/head";
import { ReactNode } from "react";
import { signOut, useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";

interface ScannerLayoutProps {
  children: ReactNode;
  title?: string;
}

export default function ScannerLayout({ children, title }: ScannerLayoutProps) {
  const { data: session } = useSession();
  const router = useRouter();

  const handleSignOut = async () => {
    await signOut({ redirect: false });
    router.push("/auth/login");
  };

  return (
    <>
      <Head>
        <title>{title || "Inventory Count"}</title>
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"
        />
      </Head>
      <header className="w-full bg-sh-blue text-white px-4 py-2 flex items-center justify-between shadow-md">
        <h1 className="font-serif text-lg font-bold">
          {session?.user?.name ? `${session.user.name.split(" ")[0]}'s Count` : "Inventory Count"}
        </h1>
        {session && (
          <Button variant="secondary" onClick={handleSignOut}>
            Sign Out
          </Button>
        )}
      </header>
      <main className="p-2">{children}</main>
    </>
  );
}
