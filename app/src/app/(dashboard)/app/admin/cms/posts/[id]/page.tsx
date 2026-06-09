// /app/src/app/(dashboard)/app/admin/cms/posts/[id]/page.tsx

import { requirePage } from "@/lib/auth/requirePage";
import { PostEditorView } from "../PostEditorView";

export default async function EditCmsPost({ params }: { params: Promise<{ id: string }> }) {
  await requirePage(["ADMIN"], { feature: "cms" });
  const { id } = await params;
  return <PostEditorView postId={Number(id)} />;
}
