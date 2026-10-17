// /app/src/pages/api/dispatch/runs/[id]/status.ts
//
// PUT { status } -- moves a run along. What is allowed, and that a run is
// completed only once every stop is, is lib/fulfilment/runs.ts setRunStatus.

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { isRunStatus, RunError, setRunStatus } from "@/lib/fulfilment/runs";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "PUT") {
    res.setHeader("Allow", ["PUT"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid run ID" });

  const { status } = req.body;
  if (!status) return res.status(400).json({ error: "status is required" });
  if (!isRunStatus(status)) return res.status(400).json({ error: `Unknown run status ${status}` });

  try {
    const updated = await prisma.$transaction((tx) =>
      setRunStatus(tx, id, status, session.user?.email || null),
    );
    return res.status(200).json(updated);
  } catch (error) {
    if (error instanceof RunError) {
      return res.status(error.httpStatus).json({ error: error.message });
    }
    logError("Error updating run status", error);
    return res.status(500).json({ error: "Failed to update run status" });
  }
}

export default requirePermission("warehouse.operate", handler);
