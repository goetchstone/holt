// /app/src/lib/validateEnv.ts
//
// Fail-fast environment validation. Run once at server startup (from
// instrumentation.ts) so a deployment missing a load-bearing secret crashes
// immediately with a clear message, instead of booting "healthy" and then
// throwing the first time the secret is touched (a runtime 500 on a real
// request — the lazy-validation trap the prod audit flagged).
//
// REQUIRED everywhere:
//   DATABASE_URL        — Prisma can't connect without it
//   NEXTAUTH_SECRET     — signs sessions + the portal/reset capability tokens
//   APP_ENCRYPTION_KEY  — decrypts IntegrationCredential; losing/omitting it
//                         bricks every stored API key (Stripe, SMTP, ...).
//                         >=16 chars (mirrors secretCrypto's own guard).
//
// CONDITIONALLY required:
//   NEXTAUTH_URL in production — NextAuth needs the canonical origin for
//   secure cookies + OAuth callbacks + the portal/email absolute URLs.
//
// Validation is shape-only (presence + length). It never logs secret VALUES.

export interface EnvProblem {
  key: string;
  message: string;
}

export function collectEnvProblems(
  env: NodeJS.ProcessEnv = process.env,
  isProd: boolean = env.NODE_ENV === "production",
): EnvProblem[] {
  const problems: EnvProblem[] = [];
  const require = (key: string, min = 1) => {
    const v = env[key];
    if (!v || v.trim().length < min) {
      problems.push({
        key,
        message:
          min > 1
            ? `${key} is missing or shorter than ${min} characters`
            : `${key} is required but not set`,
      });
    }
  };

  require("DATABASE_URL");
  require("NEXTAUTH_SECRET", 16);
  require("APP_ENCRYPTION_KEY", 16);

  // In production the canonical URL is mandatory; in dev NextAuth infers it.
  if (isProd) {
    const url = env.NEXTAUTH_URL;
    if (!url || url.trim().length === 0) {
      problems.push({ key: "NEXTAUTH_URL", message: "NEXTAUTH_URL is required in production" });
    } else if (!/^https:\/\//.test(url)) {
      problems.push({
        key: "NEXTAUTH_URL",
        message: "NEXTAUTH_URL must be https:// in production (secure cookies depend on it)",
      });
    }
  }

  return problems;
}

/**
 * Throw if any required env var is missing/malformed. Called from
 * instrumentation.ts so the failure happens at boot, before the server
 * accepts traffic.
 */
export function assertEnv(env: NodeJS.ProcessEnv = process.env): void {
  const problems = collectEnvProblems(env);
  if (problems.length === 0) return;
  const lines = problems.map((p) => `  - ${p.message}`).join("\n");
  throw new Error(
    `Refusing to start: ${problems.length} environment problem(s):\n${lines}\n` +
      "Set these and restart. See env.example + docs/SECRETS.md.",
  );
}
