// /app/src/app/(dashboard)/app/admin/bookings/page.tsx
//
// Admin Bookings page. ADMIN-only, gated behind the "booking" feature. Resolves
// the staff iCal subscription feed URL server-side (the BOOKING_FEED_TOKEN never
// reaches the client except as part of this already-ADMIN-gated URL) and renders
// the client list view.

import { requirePage } from "@/lib/auth/requirePage";
import { BookingsView } from "./BookingsView";

function resolveFeedUrl(): string | null {
  const token = process.env.BOOKING_FEED_TOKEN;
  if (!token) return null;
  const base = (process.env.NEXTAUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/api/bookings/feed.ics?token=${encodeURIComponent(token)}`;
}

export default async function AdminBookingsPage() {
  await requirePage(["ADMIN"], { feature: "booking" });
  return <BookingsView feedUrl={resolveFeedUrl()} />;
}
