// /app/src/pages/api/printers/[id]/index.ts

import { prisma } from "@/lib/prisma";
import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";
import { getErrorCode } from "@/lib/errorCode";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const printerId = Number.parseInt(req.query.id as string);

  if (Number.isNaN(printerId)) {
    return res.status(400).json({ error: "Invalid printer ID" });
  }

  // GET a single printer
  if (req.method === "GET") {
    try {
      const printer = await prisma.printer.findUnique({
        where: { id: printerId },
      });
      if (!printer) {
        return res.status(404).json({ error: "Printer not found" });
      }
      return res.status(200).json(printer);
    } catch (err) {
      logError("GET /printers/[id] error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  // PUT (Update) a printer
  if (req.method === "PUT") {
    const { name, ipAddress, port, location, tagType, store, currentSize } = req.body;

    if (!name || !ipAddress || !port || !location || !tagType || !store) {
      return res.status(400).json({ error: "Missing required fields for update" });
    }

    try {
      const updated = await prisma.printer.update({
        where: { id: printerId },
        data: {
          name,
          ipAddress,
          port: Number.parseInt(port, 10),
          location,
          tagType,
          store,
          currentSize: currentSize || null,
        },
      });
      return res.status(200).json(updated);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002") {
        return res
          .status(409)
          .json({ error: `Printer with name '${name}' or IP '${ipAddress}' already exists.` });
      }
      logError("PUT /printers/[id] error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  // DELETE a printer
  if (req.method === "DELETE") {
    try {
      await prisma.printer.delete({
        where: { id: printerId },
      });
      return res.status(204).end(); // No content for successful deletion
    } catch (err) {
      logError("DELETE /printers/[id] error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}
