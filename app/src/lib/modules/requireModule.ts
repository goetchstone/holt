// /app/src/lib/modules/requireModule.ts
//
// CLAUDE.md rule 42: a safety guard is one shared function on every path that
// needs it. Before this file, "is this module on, and if not, 404" was
// hand-written at every call site (App Router pages via notFound(), Pages
// Router API routes via res.status(404), tRPC procedures via TRPCError) --
// nine near-identical `getAppSettings()` + `isFeatureEnabled()` pairs across
// the DMARC, billing, client-portal, helpdesk, legacy-archive, comments, and
// legacy-POS-import surfaces. A new surface could forget the check; nothing
// enforced that all of them agreed on what "off" means.
//
// isModuleEnabled() is the one shared check. requireModule() adds the
// App-Router 404 on top of it for server-component pages -- Pages Router
// handlers and tRPC procedures call isModuleEnabled() directly because they
// each need to shape their own response (JSON body vs TRPCError).

import { notFound } from "next/navigation";
import { getAppSettings } from "@/lib/appSettings";
import { isFeatureEnabled } from "@/lib/featureCatalog";

// True when `key` is enabled for this deployment. Same resolution as
// isFeatureEnabled (explicit AppSettings value wins, else the manifest
// default) -- this just folds in the getAppSettings() fetch so callers stop
// repeating the pair.
export async function isModuleEnabled(key: string): Promise<boolean> {
  const settings = await getAppSettings();
  return isFeatureEnabled(settings.features, key);
}

// App Router server-component guard: 404s (notFound(), never returns) when
// `key` is disabled. Use at the top of a page/layout, mirroring the
// `getAppSettings()` + `isFeatureEnabled()` + `notFound()` block it replaces.
//
//   export default async function DmarcCheckPage() {
//     await requireModule("dmarcTools");
//     ...
//   }
export async function requireModule(key: string): Promise<void> {
  if (!(await isModuleEnabled(key))) notFound();
}
