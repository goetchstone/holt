// /app/src/app/(dashboard)/layout.tsx
//
// Shared chrome for App Router authed pages — the App Router counterpart to the
// Pages-Router MainLayout (TopNav + centered max-width main + Akritos maker
// footer). Server component; the nav is a client island (AppNav). Per-page
// auth/role gating stays in each page via requirePage (this layout doesn't gate
// so public-ish dashboard sub-routes can opt out if ever needed).

import { AppShell } from "@/components/navigation/AppShell";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
