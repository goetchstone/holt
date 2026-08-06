// /app/src/instrumentation.ts
//
// Next.js startup hook (runs once when the server process boots, before it
// serves traffic). Two jobs:
//
//   1. Fail-fast on a misconfigured environment — a deployment missing
//      NEXTAUTH_SECRET / APP_ENCRYPTION_KEY / DATABASE_URL should crash here
//      with a clear message, not 500 on the first request that touches the
//      missing value.
//
//   2. Reconcile the built-in roles (lib/auth/permissionCatalog.ts) into
//      Role/RolePermission rows. This is the "runs wherever migrations run"
//      requirement: docker-entrypoint.sh applies migrations and then execs
//      `next start`, so this hook is strictly downstream of every migrate in
//      every deploy path — and it also covers the paths that never touch the
//      entrypoint at all (`npm run dev`, a restored dump). It has to live here
//      rather than in the entrypoint script because the production image ships
//      only .next/, node_modules/ and prisma/ (see Dockerfile stage 3): there
//      is no src/ or scripts/ in the container for a ts-node script to import.
//
//      Failure is logged, NOT fatal. The migration that created these tables
//      seeded the eight roles itself, so a reconcile that cannot run leaves a
//      working installation rather than a broken one; refusing to serve traffic
//      over it would turn a stale grant into an outage.
//
// Guard on the nodejs runtime so the edge runtime (which can't read these)
// doesn't trip it.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertEnv } = await import("@/lib/validateEnv");
  assertEnv();

  const { syncBuiltInRoles } = await import("@/lib/auth/builtInRoles");
  const { logger, logError } = await import("@/lib/logger");
  try {
    const result = await syncBuiltInRoles();
    if (!result.unchanged) {
      logger.info("Built-in roles reconciled", {
        rolesCreated: result.rolesCreated,
        rolesUpdated: result.rolesUpdated,
        grantsAdded: result.grantsAdded,
        grantsRemoved: result.grantsRemoved,
        grantsSkippedCustomized: result.grantsSkippedCustomized,
      });
    }
  } catch (err) {
    logError("Built-in role reconcile failed at startup", err);
  }
}
