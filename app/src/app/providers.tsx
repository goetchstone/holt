"use client";

// /app/src/app/providers.tsx
//
// Client-side provider stack for the App Router tree, mirroring what
// pages/_app.tsx supplies to the Pages Router. Both routers run side-by-side
// during the incremental migration; this is the App Router half. The tRPC
// provider is layered onto the QueryClientProvider here in a later phase (F3).

import { useState, type ReactNode } from "react";
import { SessionProvider } from "next-auth/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { BrandingProvider } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";
import type { Branding } from "@/lib/branding";

export function Providers({ branding, children }: { branding: Branding; children: ReactNode }) {
  // One QueryClient + tRPC client per browser session (created lazily so they
  // aren't shared across server requests). superjson matches the server
  // transformer so Date/Decimal round-trip.
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    api.createClient({
      links: [httpBatchLink({ url: "/api/trpc", transformer: superjson })],
    }),
  );

  return (
    <SessionProvider>
      <api.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <BrandingProvider value={branding}>
            {children}
            <ToastContainer position="bottom-right" autoClose={3000} />
          </BrandingProvider>
        </QueryClientProvider>
      </api.Provider>
    </SessionProvider>
  );
}
