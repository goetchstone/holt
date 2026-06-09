// /app/src/pages/api/admin/database/restore.ts
//
// Streams a pg_dump .sql file directly to psql without buffering the entire
// file in memory. The request body is piped raw (not parsed as JSON) so that
// large backups (150mb+) don't exhaust Node's heap.

import { NextApiRequest, NextApiResponse } from "next";
import { spawn } from "child_process";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

// Pin the absolute path so a poisoned PATH (writable directory shadowing
// /usr/bin) can never substitute our binary. Production container is
// node:24-alpine + apk postgresql-client, which always installs here.
// PSQL_PATH env var allows local-dev override (e.g. macOS Homebrew).
const PSQL_PATH = process.env.PSQL_PATH || "/usr/bin/psql";

export const config = {
  api: {
    bodyParser: false,
  },
};

function runPsql(dbUrl: string, input: string): Promise<{ success: boolean; stderr: string }> {
  return new Promise((resolve, reject) => {
    const psql = spawn(PSQL_PATH, [dbUrl]);
    let stderr = "";
    psql.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    psql.on("error", reject);
    psql.on("close", (code) => resolve({ success: code === 0, stderr }));
    psql.stdin.write(input);
    psql.stdin.end();
  });
}

function streamToPsql(
  dbUrl: string,
  stream: NodeJS.ReadableStream,
): Promise<{ success: boolean; stderr: string }> {
  return new Promise((resolve, reject) => {
    const psql = spawn(PSQL_PATH, [dbUrl]);
    let stderr = "";
    psql.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    psql.on("error", reject);
    psql.on("close", (code) => resolve({ success: code === 0, stderr }));
    stream.pipe(psql.stdin);
  });
}

export default requireAuthWithRole(["ADMIN"], async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return res.status(500).json({ error: "DATABASE_URL not configured" });
  }

  try {
    // Drop and recreate the public schema so the restore starts clean.
    const reset = await runPsql(dbUrl, "DROP SCHEMA public CASCADE; CREATE SCHEMA public;\n");
    if (!reset.success) {
      return res.status(500).json({
        success: false,
        error: "Failed to reset schema before restore",
        details: reset.stderr.slice(0, 2000),
      });
    }

    // Stream the request body directly to psql
    const result = await streamToPsql(dbUrl, req);

    if (result.success) {
      const errors = result.stderr
        .split("\n")
        .filter((line) => line.startsWith("ERROR:"))
        .join("\n");

      return res.status(200).json({
        success: true,
        message: "Database restored successfully",
        errors: errors || null,
      });
    } else {
      return res.status(500).json({
        success: false,
        error: "Restore completed with errors",
        details: result.stderr.slice(0, 2000),
      });
    }
  } catch (err: unknown) {
    logError("Database restore error", err);
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return res.status(500).json({ error: "psql is not available in this environment" });
    }
    return res.status(500).json({ error: "Failed to restore database" });
  }
});
