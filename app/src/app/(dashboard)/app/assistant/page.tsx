// /app/src/app/(dashboard)/app/assistant/page.tsx
//
// AI Assistant: the read-only data chatbot (ask in English, get an answer from
// the tenant's own database via guarded text-to-SQL). 404s when the "ai" module
// is off -- the same registry flag the chat.ask endpoint will gate on in a later
// phase (routers/chat.ts).
//
// TODO: register nav item once feat/nav-from-permissions lands

import { requireModule } from "@/lib/modules/requireModule";
import { PageHeader } from "@/components/ui/PageHeader";
import { ChatPanel } from "@/components/ai/ChatPanel";

export default async function AssistantPage() {
  await requireModule("ai");
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
