// /app/src/app/(dashboard)/app/page.tsx
//
// Root home ("/") -- manager-facing dashboard. App Router port of
// pages/index.tsx. Authed via requirePage; designers are redirected straight to
// Sales (the dashboard is manager-facing), mirroring the legacy getServerSideProps
// role redirect. The (dashboard) layout supplies the nav chrome, so HomeView
// renders content only (no MainLayout).

import { redirect } from "next/navigation";
import { requirePage } from "@/lib/auth/requirePage";
import { HomeView } from "./HomeView";

export default async function HomePage() {
  const { role } = await requirePage();
  if (role === "DESIGNER") {
    redirect("/app/sales");
  }
  return <HomeView />;
}
