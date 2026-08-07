// /app/src/lib/ai/registry.ts
//
// AI-provider registry + resolution. Same shape as lib/adapters/index.ts: a
// flat catalog, a BY_ID lookup, and a resolver that throws on an unknown id --
// not a DI container, because the set of providers is compile-time known and
// nothing else in this codebase uses one.
//
// Phase 1 resolves the active provider from the AI_PROVIDER env var (default
// "ollama"); there is deliberately no migration and no AppSettings column yet
// (that is phase 3), so this cannot collide with in-flight schema work.

import { ollamaProvider } from "@/lib/ai/providers/ollama";
import type { AiProvider } from "@/lib/ai/types";

/**
 * Every AI provider this build knows about. Adding one (Anthropic / OpenAI in
 * phase 3) is: implement AiProvider, add one line here, ship.
 */
export const AI_PROVIDERS: AiProvider[] = [ollamaProvider];

const BY_ID = new Map(AI_PROVIDERS.map((p) => [p.id, p]));

/** Catalog for an admin picker. Never includes secrets. */
export function listAiProviders(): { id: string; label: string }[] {
  return AI_PROVIDERS.map((p) => ({ id: p.id, label: p.label }));
}

/**
 * Look up by id. Throws rather than returning undefined -- every caller needs a
 * provider to continue, and an operator-readable message beats a null-deref
 * three frames later. Same reasoning as getSourceAdapter().
 */
export function getAiProvider(id: string): AiProvider {
  const provider = BY_ID.get(id);
  if (!provider) {
    throw new Error(
      `AI provider "${id}" is not available in this build. ` +
        `Known providers: ${AI_PROVIDERS.map((p) => p.id).join(", ")}. ` +
        `Check the AI_PROVIDER environment variable.`,
    );
  }
  return provider;
}

/**
 * The provider this deployment uses, from AI_PROVIDER (default "ollama"). An id
 * that no longer exists in the build throws -- that is a misconfigured
 * deployment, and failing loudly beats silently answering nothing.
 */
export function getActiveAiProvider(): AiProvider {
  return getAiProvider(process.env.AI_PROVIDER ?? "ollama");
}
