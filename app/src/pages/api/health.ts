// /app/src/pages/api/health.ts
//
// Unauthenticated status endpoint. Returns the application version,
// build metadata, and database connectivity so operators can verify
// the system is healthy after a deploy.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  let database = "ok";
  try {
    await prisma.$queryRaw(Prisma.sql`SELECT 1`);
  } catch {
    database = "error";
  }

  const status = database === "ok" ? "ok" : "degraded";

  res.status(status === "ok" ? 200 : 503).json({
    status,
    database,
    version: process.env.npm_package_version || "unknown",
    gitCommit: process.env.GIT_COMMIT || "unknown",
    nodeEnv: process.env.NODE_ENV || "unknown",
    timestamp: new Date().toISOString(),
  });
}
