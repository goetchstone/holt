// /app/src/instrumentation.ts
//
// Next.js startup hook (runs once when the server process boots, before it
// serves traffic). We use it to fail-fast on a misconfigured environment —
// a deployment missing NEXTAUTH_SECRET / APP_ENCRYPTION_KEY / DATABASE_URL
// should crash here with a clear message, not 500 on the first request that
// touches the missing value.
//
// Guard on the nodejs runtime so the edge runtime (which can't read these)
// doesn't trip it.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertEnv } = await import("@/lib/validateEnv");
  assertEnv();
}
