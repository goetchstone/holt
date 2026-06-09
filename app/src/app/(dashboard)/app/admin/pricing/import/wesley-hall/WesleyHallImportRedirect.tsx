"use client";

// /app/src/app/(dashboard)/app/admin/pricing/import/wesley-hall/WesleyHallImportRedirect.tsx
//
// Client redirect to the generic import page with the Wesley Hall vendor
// pre-selected. App Router port of the legacy redirect body.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function WesleyHallImportRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/app/admin/pricing/import?vendor=wesley-hall");
  }, [router]);

  return null;
}
