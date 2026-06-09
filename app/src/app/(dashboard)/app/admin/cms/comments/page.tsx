// /app/src/app/(dashboard)/app/admin/cms/comments/page.tsx
//
// Blog comment moderation (ADMIN, under the Content hub). Gated by the cms
// feature like the rest of the CMS admin.

import { requirePage } from "@/lib/auth/requirePage";
import { CommentsModerationView } from "./CommentsModerationView";

export default async function CommentsPage() {
  await requirePage(["ADMIN"], { feature: "cms" });
  return <CommentsModerationView />;
}
