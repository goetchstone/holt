// /app/src/app/(dashboard)/app/sales/orders/page.tsx
//
// Sales orders list — App Router port of the legacy sales/orders/index. Any
// signed-in user (mirrors the legacy withAuth() with no roles). Reads the shared
// /api/sales/orders REST endpoint, which stays REST. Chrome from the (dashboard)
// layout. The order detail route stays in Pages Router (/sales/orders/[id]) — no
// collision with this list path. The view reads ?status= via useSearchParams, so
// it renders inside a Suspense boundary.

import { Suspense } from "react";
import { requirePage } from "@/lib/auth/requirePage";
import { OrdersListView } from "./OrdersListView";

export default async function SalesOrdersListPage() {
  await requirePage();
  return (
    <Suspense fallback={null}>
      <OrdersListView />
    </Suspense>
  );
}
