// /app/src/pages/api/print-label.ts
//
// Sends a ZPL label to a Zebra printer over TCP. Renders a label template
// with product data using Mustache, then opens a raw TCP socket to the
// printer's IP address.

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { printLabel } from "@/lib/labelPrinter";
import { rateLimit } from "@/lib/rateLimit";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { productId, templateId, printerId } = req.body;

    const productIdInt = Number.parseInt(productId);
    const templateIdInt = Number.parseInt(templateId);
    const printerIdInt = Number.parseInt(printerId);

    if (Number.isNaN(productIdInt) || Number.isNaN(templateIdInt) || Number.isNaN(printerIdInt)) {
      return res.status(400).json({ error: "Invalid productId, templateId, or printerId" });
    }

    const zpl = await printLabel(productIdInt, templateIdInt, printerIdInt);

    return res.status(200).json({ message: "Label sent to printer", zpl });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    logError("Print error", err);
    return res.status(500).json({ error: message });
  }
}

export default rateLimit({ windowMs: 60000, maxRequests: 30 })(handler);
