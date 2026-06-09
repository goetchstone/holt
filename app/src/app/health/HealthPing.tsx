"use client";

// /app/src/app/health/HealthPing.tsx
//
// Client component that exercises the tRPC client end-to-end: calls
// api.health.ping over /api/trpc and renders the result. Proves the full
// chain (client → httpBatchLink → fetch route → router → superjson) works in
// the browser. Part of the F3 foundation check; removed once real tRPC-backed
// UI exists.

import { api } from "@/lib/trpc/client";

export function HealthPing() {
  const ping = api.health.ping.useQuery();

  let status: string;
  if (ping.isLoading) status = "checking…";
  else if (ping.error) status = `error: ${ping.error.message}`;
  else status = ping.data?.ok ? "ok" : "unexpected response";

  return (
    <p className="mt-1 text-sm text-sh-gray">
      tRPC health.ping: <span className="font-mono">{status}</span>
    </p>
  );
}
