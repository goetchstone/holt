// /app/src/pages/api/admin/database/restore.ts
//
// Restore the database from an uploaded pg_dump .sql file.
//
// The upload is SPOOLED TO A TEMP FILE, not buffered in memory -- a production
// dump is 150mb+ and would exhaust Node's heap. It is then validated, and only
// then is the existing schema dropped.
//
// That ordering is the whole point of this file. It previously piped the
// request body straight into psql, which meant `DROP SCHEMA public CASCADE`
// ran BEFORE anything had looked at the upload: a truncated download, a
// wrong-file mistake, or a dropped connection destroyed the database and left
// nothing to restore from. Spooling first costs one disk write of temp space
// and turns an unrecoverable mistake into a 400.
//
// It also reported "Database restored successfully" whenever psql exited 0 --
// and psql exits 0 despite ERROR lines unless ON_ERROR_STOP is set. A dump
// that half-applied looked like a clean restore. Both are fixed here:
// ON_ERROR_STOP makes psql stop and fail on the first error, and any ERROR
// output is treated as failure rather than reported alongside "successfully".

import { NextApiRequest, NextApiResponse } from "next";
import { spawn } from "child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { requirePermission } from "@/lib/auth/requireAuth";
import { logError, logger } from "@/lib/logger";
import { auditLog } from "@/lib/audit";

// Pin the absolute path so a poisoned PATH (writable directory shadowing
// /usr/bin) can never substitute our binary. Production container is
// node:24-alpine + apk postgresql-client, which always installs here.
// PSQL_PATH env var allows local-dev override (e.g. macOS Homebrew).
const PSQL_PATH = process.env.PSQL_PATH || "/usr/bin/psql";

/** Upper bound on an accepted dump. Guards the temp volume from a runaway or
 *  hostile upload; raise it if a real dump ever approaches this. */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

/** pg_dump's first and last lines. Both must be present for the file to be a
 *  complete dump rather than a prefix of one. */
const DUMP_HEADER = "PostgreSQL database dump";
const DUMP_FOOTER = "PostgreSQL database dump complete";

export const config = {
  api: {
    bodyParser: false,
  },
};

function runPsql(dbUrl: string, input: string): Promise<{ success: boolean; stderr: string }> {
  return new Promise((resolve, reject) => {
    const psql = spawn(PSQL_PATH, ["-v", "ON_ERROR_STOP=1", dbUrl]);
    let stderr = "";
    psql.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    psql.on("error", reject);
    psql.on("close", (code) => resolve({ success: code === 0, stderr }));
    psql.stdin.write(input);
    psql.stdin.end();
  });
}

function restoreFromFile(
  dbUrl: string,
  filePath: string,
): Promise<{ success: boolean; stderr: string }> {
  return new Promise((resolve, reject) => {
    // ON_ERROR_STOP: without it psql reports exit 0 after logging ERROR lines,
    // so a dump that half-applied is indistinguishable from a clean restore.
    const psql = spawn(PSQL_PATH, ["-v", "ON_ERROR_STOP=1", dbUrl]);
    let stderr = "";
    psql.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    psql.on("error", reject);
    psql.on("close", (code) => resolve({ success: code === 0, stderr }));
    createReadStream(filePath).pipe(psql.stdin);
  });
}

/** Read the first and last bytes without loading the file. */
async function readEdges(
  filePath: string,
  bytes = 4096,
): Promise<{ head: string; tail: string; size: number }> {
  const { size } = await stat(filePath);
  const fh = await open(filePath, "r");
  try {
    const headBuf = Buffer.alloc(Math.min(bytes, size));
    await fh.read(headBuf, 0, headBuf.length, 0);
    const tailLen = Math.min(bytes, size);
    const tailBuf = Buffer.alloc(tailLen);
    await fh.read(tailBuf, 0, tailLen, Math.max(0, size - tailLen));
    return { head: headBuf.toString("utf8"), tail: tailBuf.toString("utf8"), size };
  } finally {
    await fh.close();
  }
}

export default requirePermission(
  "admin.data",
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") {
      res.setHeader("Allow", ["POST"]);
      return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      return res.status(500).json({ error: "DATABASE_URL not configured" });
    }

    const spoolPath = path.join(tmpdir(), `holt-restore-${Date.now()}-${process.pid}.sql`);
    const actor = session.user?.email || "unknown";

    try {
      // --- 1. Spool to disk (bounded), touching nothing in the database -------
      let received = 0;
      let tooLarge = false;
      req.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_UPLOAD_BYTES && !tooLarge) {
          tooLarge = true;
          req.destroy();
        }
      });

      try {
        await pipeline(req, createWriteStream(spoolPath));
      } catch {
        if (tooLarge) {
          return res
            .status(413)
            .json({ error: `Upload exceeds the ${MAX_UPLOAD_BYTES} byte limit` });
        }
        // A dropped connection lands here -- and the database is still intact,
        // which is the entire reason for spooling before dropping.
        return res.status(400).json({ error: "Upload failed or was interrupted; nothing changed" });
      }

      // --- 2. Validate BEFORE destroying anything -----------------------------
      const { head, tail, size } = await readEdges(spoolPath);

      if (size === 0) {
        return res.status(400).json({ error: "Uploaded file is empty; nothing changed" });
      }
      if (!head.includes(DUMP_HEADER)) {
        return res
          .status(400)
          .json({ error: "File does not look like a pg_dump SQL file; nothing changed" });
      }
      if (!tail.includes(DUMP_FOOTER)) {
        return res.status(400).json({
          error:
            "Dump is truncated (missing pg_dump's completion marker). Restoring it would " +
            "give you a partial database. Nothing changed.",
        });
      }

      logger.info("Database restore starting", { actor, bytes: size });
      auditLog("DATABASE_RESTORE", actor, { bytes: size });

      // --- 3. Only now is it safe to drop -------------------------------------
      const reset = await runPsql(dbUrl, "DROP SCHEMA public CASCADE; CREATE SCHEMA public;\n");
      if (!reset.success) {
        return res.status(500).json({
          success: false,
          error: "Failed to reset schema before restore",
          details: reset.stderr.slice(0, 2000),
        });
      }

      const result = await restoreFromFile(dbUrl, spoolPath);

      // psql with ON_ERROR_STOP exits non-zero on the first error, but check the
      // stream too -- "succeeded except for the errors" is not a success.
      const errorLines = result.stderr
        .split("\n")
        .filter((line) => line.startsWith("ERROR:"))
        .join("\n");

      if (!result.success || errorLines) {
        logError("Database restore failed", new Error(errorLines || "psql exited non-zero"), {
          actor,
        });
        return res.status(500).json({
          success: false,
          error: "Restore FAILED. The database may be empty or partially restored.",
          details: (errorLines || result.stderr).slice(0, 2000),
        });
      }

      logger.info("Database restore completed", { actor, bytes: size });
      return res.status(200).json({ success: true, message: "Database restored successfully" });
    } catch (err: unknown) {
      logError("Database restore error", err, { actor });
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        return res.status(500).json({ error: "psql is not available in this environment" });
      }
      return res.status(500).json({ error: "Failed to restore database" });
    } finally {
      await rm(spoolPath, { force: true }).catch(() => {});
    }
  },
);
