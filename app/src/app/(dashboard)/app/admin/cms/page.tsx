// /app/src/app/(dashboard)/app/admin/cms/page.tsx
//
// Content (CMS) hub, on Change settings. Links to the page, post, and menu
// editors that drive the public (site) surface; a card shows only to a viewer
// holding the key of the page it opens (lib/auth/hubCards.ts).

import { requirePage } from "@/lib/auth/requirePage";
import { hubCardKeys, visibleHubCards } from "@/lib/auth/hubCards";
import CardGrid, { type CardGridItem } from "@/components/layout/CardGrid";

const ITEMS: CardGridItem[] = [
  {
    title: "Pages",
    description: "Create and edit public marketing pages with content blocks.",
    href: "/app/admin/cms/pages",
  },
  {
    title: "Posts",
    description: "Write and publish blog posts.",
    href: "/app/admin/cms/posts",
  },
  {
    title: "Menus",
    description: "Edit the public site header and footer navigation.",
    href: "/app/admin/cms/menus",
  },
  {
    title: "Comments",
    description: "Moderate blog comments — approve, reject, or mark spam.",
    href: "/app/admin/cms/comments",
  },
];

export default async function CmsHubPage() {
  const { holds } = await requirePage(undefined, {
    permission: "admin.settings",
    feature: "cms",
    also: hubCardKeys(ITEMS),
  });
  return <CardGrid title="Content (CMS)" items={visibleHubCards(ITEMS, holds)} />;
}
