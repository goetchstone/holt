// /app/__tests__/fixtures/pageWithoutClientViews/fixturePage.tsx
//
// A server page for pageWithoutClientViews.test.ts. It renders three exports of
// a client module that throws if it ever loads (its default, a function and a
// const), a real client component imported through "@/", and a title from a
// server module it runs.

import CardGrid from "@/components/layout/CardGrid";
import ClientFrame, { ClientBadge, ClientView } from "./ClientView";
import { greet } from "./greet";

export default async function FixturePage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return (
    <ClientFrame title={greet(name)}>
      <ClientView label={name} />
      <ClientBadge />
      <CardGrid title="Hub" items={[]} />
    </ClientFrame>
  );
}
