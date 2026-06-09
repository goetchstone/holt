// /app/src/pages/api/admin/database/backup.ts

import { NextApiRequest, NextApiResponse } from "next";
import { spawn } from "child_process";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

// Pin the absolute path so a poisoned PATH (writable directory shadowing
// /usr/bin) can never substitute our binary. The production container is
// node:24-alpine + apk postgresql-client, which always installs here.
// PG_DUMP_PATH env var allows local-dev override (e.g. macOS Homebrew).
const PG_DUMP_PATH = process.env.PG_DUMP_PATH || "/usr/bin/pg_dump";

export const config = {
  api: {
    responseLimit: false,
  },
};

export default requireAuthWithRole(["ADMIN"], async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return res.status(500).json({ error: "DATABASE_URL not configured" });
  }

  const timestamp = new Date()
    .toLocaleString("sv-SE", { timeZone: "America/New_York" })
    .replace(/[: ]/g, "-")
    .slice(0, 19);
  const filename = `holt-backup-${timestamp}.sql`;

  res.setHeader("Content-Type", "application/sql");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  const pgDump = spawn(PG_DUMP_PATH, [
    "--no-owner",
    "--no-privileges",
    "--clean",
    "--if-exists",
    dbUrl,
  ]);

  pgDump.stdout.pipe(res);

  pgDump.stderr.on("data", (data: Buffer) => {
    logError("pg_dump stderr", new Error(data.toString()));
  });

  pgDump.on("error", (err) => {
    logError("pg_dump spawn error", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "pg_dump is not available in this environment" });
    }
  });

  pgDump.on("close", (code) => {
    if (code !== 0 && !res.headersSent) {
      res.status(500).json({ error: `pg_dump exited with code ${code}` });
    }
  });
});
