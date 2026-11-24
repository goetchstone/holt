// /app/src/app/(dashboard)/layout.tsx
//
// Shared chrome for App Router authed pages: the sidebar, top bar, content
// canvas and maker footer. Server component; the chrome is a client island
// (AppShell, which renders AppSidebar and AppTopbar). Per-page auth gating stays
// in each page via requirePage (this layout doesn't gate so public-ish
// dashboard sub-routes can opt out if ever needed).

import { AppShell } from "@/components/navigation/AppShell";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
