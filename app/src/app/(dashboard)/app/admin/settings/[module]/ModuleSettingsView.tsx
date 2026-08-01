"use client";

// /app/src/app/(dashboard)/app/admin/settings/[module]/ModuleSettingsView.tsx
//
// Generic renderer for a module's manifest entry (lib/modules/types.ts
// ModuleDef). Two sections, each optional:
//
//   - `nav`      -- link cards out to the module's own pages.
//   - `settings.fields` -- declarative field list, same spirit as
//     lib/integrationCatalog.ts INTEGRATION_PROVIDERS. Rendered read-only
//     for now: no shipped module has fields yet (dmarcTools -- the first
//     real module -- only has `nav`), so there's no AppSettings column to
//     persist them to. Wiring a save path is future work for whichever
//     module needs it first; see docs/domains/modules.md.
//
// A module reaches this component only when isModuleSettingsRoutable()
// already confirmed it's enabled and has at least one of the two sections
// (see ../[module]/page.tsx), so the "nothing to show" fallback below is a
// belt-and-suspenders case, not something a user should ever hit.

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { ModuleDef } from "@/lib/modules";

export function ModuleSettingsView({ module: mod }: Readonly<{ module: ModuleDef }>) {
  const hasNav = (mod.nav?.length ?? 0) > 0;
  const hasFields = (mod.settings?.fields?.length ?? 0) > 0;

  return (
    <div className="max-w-2xl space-y-8 pb-16">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="font-serif text-2xl text-sh-blue">{mod.name}</h1>
          <span className="rounded-full border border-sh-brand-gray px-2 py-0.5 text-[10px] uppercase tracking-wide text-sh-gray">
            {mod.category}
          </span>
        </div>
        <p className="mt-1 text-sm text-sh-gray">{mod.description}</p>
        {mod.docs && (
          <p className="mt-2 text-xs text-sh-gray">
            Runbook: <code className="text-sh-black">{mod.docs}</code>
          </p>
        )}
      </div>

      {hasNav && (
        <section className="space-y-3">
          <h2 className="font-serif text-lg text-sh-blue">Pages</h2>
          <div className="space-y-2">
            {mod.nav!.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center justify-between rounded-md border border-sh-brand-gray p-3 text-sm text-sh-black transition hover:border-sh-blue"
              >
                <span>
                  <span className="block font-medium">{item.label}</span>
                  <span className="block text-xs text-sh-gray">{item.href}</span>
                </span>
                <ArrowUpRight className="h-4 w-4 shrink-0 text-sh-gray" />
              </Link>
            ))}
          </div>
        </section>
      )}

      {hasFields && (
        <section className="space-y-3">
          <h2 className="font-serif text-lg text-sh-blue">Settings</h2>
          <p className="text-xs text-sh-gray">
            Declared in the manifest, not yet wired to a save endpoint -- no module ships
            configurable fields today. See docs/domains/modules.md.
          </p>
          <dl className="space-y-2">
            {mod.settings!.fields!.map((f) => (
              <div key={f.key} className="rounded-md border border-sh-brand-gray p-3">
                <dt className="text-sm font-medium text-sh-black">{f.label}</dt>
                <dd className="text-xs text-sh-gray">
                  {f.key} ({f.type ?? "text"})
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {!hasNav && !hasFields && (
        <p className="text-sm text-sh-gray">This module has no configurable settings.</p>
      )}
    </div>
  );
}
