// /app/e2e/signIn.ts
//
// Playwright globalSetup: sign in once as the seeded admin through the real
// NextAuth credentials handshake (as scripts/smoke.sh does) and save the
// session for every page test. Needs AUTH_LOCAL_ENABLED=true on the app.
//
// It also records which optional modules are on (e2e/.auth/features.json), so
// a page whose module is off is reported as skipped, not as broken. With
// SMOKE_ALL_MODULES=1 it first switches every module on, through the admin
// settings API as the signed-in admin would. That changes the deployment's
// settings, so it is for a throwaway database (CI's), never a real one.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { request, type FullConfig } from "@playwright/test";
import { MODULES } from "../src/lib/modules/registry";

export const FEATURES_FILE = join(__dirname, ".auth", "features.json");

export default async function signIn(config: FullConfig): Promise<void> {
  const { baseURL, storageState } = config.projects[0].use;
  const email = process.env.SMOKE_EMAIL ?? "admin@example.com";
  const password = process.env.SMOKE_PASSWORD ?? "Showroom2026!";

  const ctx = await request.newContext({ baseURL });
  const { csrfToken } = (await (await ctx.get("/api/auth/csrf")).json()) as { csrfToken: string };
  await ctx.post("/api/auth/callback/credentials", {
    form: { csrfToken, email, password, json: "true" },
  });
  const session = (await (await ctx.get("/api/auth/session")).json()) as { user?: unknown };
  if (!session.user) {
    throw new Error(
      `could not sign in as ${email} at ${baseURL}: is AUTH_LOCAL_ENABLED=true and the seed run?`,
    );
  }
  if (process.env.SMOKE_ALL_MODULES === "1") {
    const features = Object.fromEntries(MODULES.map((m) => [m.key, true]));
    const put = await ctx.put("/api/admin/settings", { data: { features } });
    if (!put.ok()) {
      throw new Error(`could not switch every module on: ${put.status()} ${await put.text()}`);
    }
  }
  const read = await ctx.get("/api/settings/features");
  if (!read.ok()) throw new Error(`could not read the module switches: ${read.status()}`);
  const { features } = (await read.json()) as { features: Record<string, boolean> };
  writeFileSync(FEATURES_FILE, JSON.stringify(features ?? {}));

  await ctx.storageState({ path: storageState as string });
  await ctx.dispose();
}
