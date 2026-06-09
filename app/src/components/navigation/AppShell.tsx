"use client";

// /app/src/components/navigation/AppShell.tsx
//
// Client shell for the App Router back-office: persistent left sidebar +
// slim top bar + content canvas. Holds the mobile drawer open/close state and
// passes it to the sidebar + topbar. Server-rendered page `children` are passed
// through as a prop, so pages stay server components.

import { useState } from "react";
import { AppSidebar } from "./AppSidebar";
import { AppTopbar } from "./AppTopbar";
import { PRODUCT } from "@/lib/branding";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-sh-linen">
      <AppSidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppTopbar onMenuClick={() => setMobileOpen(true)} />
        <main className="min-w-0 flex-1">
          <div className="mx-auto w-full max-w-screen-xl px-4 py-6 sm:px-6">{children}</div>
        </main>
        {PRODUCT.attribution ? (
          <footer className="px-4 py-4 text-center text-xs text-sh-gray/60">
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
    </div>
  );
}
