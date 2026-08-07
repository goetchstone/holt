// /app/src/app/(dashboard)/app/assistant/page.tsx
//
// AI Assistant: the read-only data chatbot (ask in English, get an answer from
// the tenant's own database via guarded text-to-SQL).
//
// Two gates, and they are not interchangeable. The "ai" module decides whether
// this deployment has an assistant at all; reporting.read decides who may use
// it. It is the same capability chat.ask enforces (routers/chat.ts), so the
// page and the endpoint behind it cannot disagree about who belongs here --
// a page that renders and then fails every question is worse than no page.
//
// The permission check is inline rather than a requirePage option because that
// option lands with feat/nav-from-permissions; collapse it when that merges.

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { requirePage } from "@/lib/auth/requirePage";
import { resolvePermissionAccess } from "@/lib/auth/permissionResolver";
import { PageHeader } from "@/components/ui/PageHeader";
import { ChatPanel } from "@/components/ai/ChatPanel";

export default async function AssistantPage() {
  const { userId } = await requirePage(undefined, { feature: "ai" });
  const impersonate = (await cookies()).get("sh-impersonate")?.value ?? null;
  const { allowed } = await resolvePermissionAccess({
    userId,
    permission: "reporting.read",
    impersonate,
  });
  if (!allowed) redirect("/app");

  return (
    <div className="font-serif">
      <PageHeader
        title="AI Assistant"
        subtitle="Ask a question in plain English and get an answer from your own data."
      />
      <ChatPanel />
    </div>
  );
}
