// /app/src/lib/trpc/client.ts
//
// Typed tRPC React client. `api` is imported by client components to call
// procedures with full end-to-end type inference from AppRouter. The provider
// that binds it to react-query lives in src/app/providers.tsx.

import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@/server/trpc/routers/_app";

export const api = createTRPCReact<AppRouter>();
