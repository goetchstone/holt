"use client";

// /app/src/components/navigation/AppTopbar.tsx
//
// Slim top bar inside the sidebar shell: a hamburger to open the sidebar drawer
// on small screens, and the user/sign-out control on the right. Page titles are
// rendered by each page via the PageHeader primitive, not here.

import { Menu } from "lucide-react";
import { useRouter } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";

export function AppTopbar({ onMenuClick }: { onMenuClick: () => void }) {
  const { data: session } = useSession();
  const router = useRouter();

  const handleSignOut = async () => {
    await signOut({ redirect: false });
    router.push("/auth/login");
  };

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-black/10 bg-white px-4">
      <button
        type="button"
        onClick={onMenuClick}
        aria-label="Open menu"
        className="rounded-md p-2 text-sh-gray hover:bg-sh-stripe md:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      <div className="flex-1" />

      {session?.user ? (
        <div className="flex items-center gap-3">
          <span className="hidden text-sm text-sh-gray sm:inline">{session.user.email}</span>
          <Button type="button" variant="secondary" onClick={handleSignOut}>
            Sign out
          </Button>
        </div>
      ) : null}
    </header>
  );
}
