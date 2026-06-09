// /app/src/app/(dashboard)/app/admin/cms/posts/page.tsx

import { requirePage } from "@/lib/auth/requirePage";
import { PostsListView } from "./PostsListView";

export default async function CmsPostsPage() {
  await requirePage(["ADMIN"], { feature: "cms" });
  return <PostsListView />;
}
