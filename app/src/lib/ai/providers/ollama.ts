// /app/src/lib/ai/providers/ollama.ts
//
// The local-model (ollama) text-to-SQL provider. Node 24's global fetch reaches
// a local ollama daemon's /api/chat -- no SDK, no key, nothing leaves the box.
// This is the only provider phase 1 ships; Anthropic / OpenAI arrive in phase 3
// behind the same AiProvider seam.
//
// generateSql returns a raw SQL string and nothing more: it is untrusted output
// that lib/ai/sql.ts re-guards before execution. So the concerns here are just
// prompt + transport + pulling the SQL back out of a chat reply.

import { buildMessages } from "@/lib/ai/prompt";
import type { AiProvider } from "@/lib/ai/types";

/**
 * Pull the SQL back out of a chat reply. Strips any <think>...</think> the model
 * emitted despite think:false, prefers the contents of a ```sql fence (falling
 * back to the whole message), and drops any trailing semicolons.
 */
function extractSql(raw: string): string {
  const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const fence = /```sql\s*([\s\S]*?)```/i.exec(withoutThink);
  const body = fence ? fence[1] : withoutThink;
  return body
    .trim()
    .replace(/;+\s*$/, "")
    .trim();
}

interface OllamaChatResponse {
  message?: { content?: string };
}

export const ollamaProvider: AiProvider = {
  id: "ollama",
  label: "Ollama (local model)",

  async generateSql(question: string, schema: string): Promise<string> {
    const base = process.env.OLLAMA_BASE ?? "http://localhost:11434";
    const model = process.env.CHAT_MODEL ?? "qwen3.6:27b-coding-mxfp8";

    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: buildMessages(question, schema),
        stream: false,
        think: false,
        options: { temperature: 0 },
      }),
    });

    if (!res.ok) {
      throw new Error(
        `Ollama request to ${base} failed (${res.status} ${res.statusText}). ` +
          `Is the local model server running and is CHAT_MODEL ("${model}") pulled?`,
      );
    }

    const data = (await res.json()) as OllamaChatResponse;
    return extractSql(data.message?.content ?? "");
  },
};
