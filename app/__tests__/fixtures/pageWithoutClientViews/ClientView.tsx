// /app/__tests__/fixtures/pageWithoutClientViews/ClientView.tsx
//
// A client module that must never load when its page comes through
// pageWithoutClientViews: loading it throws. Its directive sits below this
// comment, as some views' do.

"use client";

import type { ReactNode } from "react";

function refuseToLoad(): void {
  throw new Error("ClientView was loaded");
}
refuseToLoad();

export type ClientViewProps = { label: string };

export function ClientView({ label }: ClientViewProps) {
  return <p>{label}</p>;
}

export const ClientBadge = () => <span>new</span>;

export default function ClientFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h1>{title}</h1>
      {children}
    </section>
  );
}
