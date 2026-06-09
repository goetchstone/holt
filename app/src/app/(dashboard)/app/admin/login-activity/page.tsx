// /app/src/app/(dashboard)/app/admin/login-activity/page.tsx
//
// Login Activity -- App Router page-only port of the legacy admin/login-activity.
// ADMIN only (mirrors the legacy withAuth roles). Reads the shared
// /api/admin/login-activity REST endpoint, which stays REST.

import { requirePage } from "@/lib/auth/requirePage";
import { LoginActivityView } from "./LoginActivityView";

export default async function LoginActivityPage() {
  await requirePage(["ADMIN"]);
  return <LoginActivityView />;
}
