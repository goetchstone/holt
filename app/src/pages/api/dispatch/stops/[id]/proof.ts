// /app/src/pages/api/dispatch/stops/[id]/proof.ts

import { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { createSecureForm } from "@/lib/secureUpload";
import { logError } from "@/lib/logger";

export const config = {
  api: {
    bodyParser: false,
  },
};

// Proof of delivery (signature + photo) should only be captured by the
// staff who actually run deliveries. A designer or marketing user has no
// legitimate workflow reason to upload proof for a stop and doing so
// would corrupt audit trail.
export default requireAuthWithRole(
  ["INSTALLER", "WAREHOUSE", "MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "POST") {
      res.setHeader("Allow", ["POST"]);
      return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    const id = Number.parseInt(req.query.id as string);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid stop ID" });

    const form = createSecureForm("DELIVERY_PROOF", {
      filename: (_orig, ext) => `stop-${id}-${Date.now()}${ext}`,
    });

    form.parse(req, async (err, fields, files) => {
      if (err) {
        logError("Proof-of-delivery form parse error", err, { id });
        return res.status(500).json({ error: "Error processing upload" });
      }

      try {
        const signatureArray = Array.isArray(fields.signature)
          ? fields.signature
          : [fields.signature];
        const signatureData = signatureArray[0] || null;

        const photoFile = Array.isArray(files.photo) ? files.photo[0] : files.photo;
        const photoPath = photoFile ? photoFile.filepath : null;

        const data: any = {};
        if (signatureData) data.signatureData = signatureData;
        if (photoPath) data.photoPath = photoPath;

        if (!signatureData && !photoPath) {
          return res.status(400).json({ error: "signature or photo is required" });
        }

        const stop = await prisma.deliveryStop.update({
          where: { id },
          data,
        });

        return res.status(200).json(stop);
      } catch (error) {
        logError("Proof-of-delivery save failed", error, { id });
        return res.status(500).json({ error: "Failed to save proof of delivery" });
      }
    });
  },
);
