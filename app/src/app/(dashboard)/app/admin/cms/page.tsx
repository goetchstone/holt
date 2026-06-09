// /app/src/app/(dashboard)/app/admin/cms/page.tsx
//
// Content (CMS) hub. ADMIN-gated. Links to the page, post, and menu editors
// that drive the public (site) surface.

import { requirePage } from "@/lib/auth/requirePage";
import CardGrid, { type CardGridItem } from "@/components/layout/CardGrid";

const ITEMS: CardGridItem[] = [
  {
    title: "Pages",
    description: "Create and edit public marketing pages with content blocks.",
    href: "/app/admin/cms/pages",
    roles: ["ADMIN"],
  },
  {
    title: "Posts",
    description: "Write and publish blog posts.",
    href: "/app/admin/cms/posts",
    roles: ["ADMIN"],
  },
  {
    title: "Menus",
    description: "Edit the public site header and footer navigation.",
    href: "/app/admin/cms/menus",
    roles: ["ADMIN"],
  },
  {
    title: "Comments",
    description: "Moderate blog comments — approve, reject, or mark spam.",
    href: "/app/admin/cms/comments",
    roles: ["ADMIN"],
  },
];

export default async function CmsHubPage() {
  await requirePage(["ADMIN"], { feature: "cms" });
  return <CardGrid title="Content (CMS)" items={ITEMS} />;
}
