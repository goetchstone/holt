// /app/src/app/(dashboard)/app/admin/cms/posts/new/page.tsx

import { requirePage } from "@/lib/auth/requirePage";
import { PostEditorView } from "../PostEditorView";

export default async function NewCmsPost() {
  await requirePage(["ADMIN"], { feature: "cms" });
  return <PostEditorView postId={null} />;
}
