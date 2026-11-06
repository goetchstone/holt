// /app/src/app/(dashboard)/app/admin/setup/email-look/page.tsx
//
// Admin > Setup > Email look and wording (GAP-37): how every email Holt sends looks, and what
// each says. Gated on admin.settings, the key its routes save with. Chrome from the
// (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { getAppSettings } from "@/lib/appSettings";
import { getEmailWordings } from "@/lib/email/wordingSettings";
import { DEFAULT_EMAIL_ACCENT } from "@/lib/email/look";
import { EmailLookView } from "./EmailLookView";

export default async function EmailLookPage() {
  await requirePage(undefined, { permission: "admin.settings" });
  const app = await getAppSettings();
  return (
    <EmailLookView
      initialLook={{
        accent: app.emailAccentColor ?? DEFAULT_EMAIL_ACCENT,
        showLogo: app.emailShowLogo,
        footer: app.emailFooter ?? "",
      }}
      hasLogo={Boolean(app.logoUrl)}
      initialWordings={await getEmailWordings()}
    />
  );
}
