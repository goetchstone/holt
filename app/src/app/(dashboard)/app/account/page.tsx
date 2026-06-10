// /app/src/app/(dashboard)/app/account/page.tsx
//
// My Account — any signed-in user: identity summary + change password (when
// local accounts are enabled). Acts only on the caller's own record.

import { requirePage } from "@/lib/auth/requirePage";
import { AccountView } from "./AccountView";

export default async function AccountPage() {
  await requirePage();
  return <AccountView />;
}
