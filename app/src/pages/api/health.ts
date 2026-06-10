// /app/src/pages/api/health.ts
//
// Unauthenticated status + readiness endpoint. Used by the container
// healthcheck and by operators after a deploy. Reports:
//   - database: can we reach Postgres
//   - settings: does the deployment's AppSettings row exist (an unseeded /
//     half-migrated DB is reachable but NOT ready to serve — create-admin +
//     settings must have run). `?ready=1` makes a missing row a 503 so the
//     orchestrator won't route traffic to an unseeded instance.
// Never exposes secrets or row contents — strings/booleans only.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  let database = "ok";
  let settings = "ok";

  try {
    await prisma.$queryRaw(Prisma.sql`SELECT 1`);
  } catch {
    database = "error";
  }

  if (database === "ok") {
    try {
      const row = await prisma.appSettings.findUnique({
        where: { organizationId: DEFAULT_ORG_ID },
        select: { id: true },
      });
      settings = row ? "ok" : "missing";
    } catch {
      // Table absent / migrations not applied yet.
      settings = "error";
    }
  } else {
    settings = "unknown";
  }

  // Liveness = DB reachable. Readiness (?ready=1) also requires the
  // AppSettings row so an unseeded instance is held out of rotation.
  const wantReady = req.query.ready === "1";
  const healthy = database === "ok" && (!wantReady || settings === "ok");

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    database,
    settings,
    version: process.env.npm_package_version || "unknown",
    gitCommit: process.env.GIT_COMMIT || "unknown",
    nodeEnv: process.env.NODE_ENV || "unknown",
    timestamp: new Date().toISOString(),
  });
}
