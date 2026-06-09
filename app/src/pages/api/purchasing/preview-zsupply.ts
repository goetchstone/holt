// /app/src/pages/api/purchasing/preview-zsupply.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { parseZSupplyPDF } from "@/lib/pricing/zSupplyParser";
import fs from "fs";
import { createSecureForm } from "@/lib/secureUpload";
import { logError } from "@/lib/logger";

export const config = { api: { bodyParser: false } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const form = createSecureForm("PDF");
    const [, files] = await form.parse(req);
    const file = Array.isArray(files.file) ? files.file[0] : files.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    const buffer = fs.readFileSync(file.filepath);
    const parsed = await parseZSupplyPDF(buffer);

    // Normalize to match the ParsedPdf interface expected by the import page
    const normalized = {
      vendorName: parsed.vendorName,
      orderNumber: parsed.orderNumber || parsed.invoiceNumber,
      poNumber: parsed.poNumber || parsed.invoiceNumber,
      orderDate: parsed.invoiceDate,
      deliveryStart: "",
      deliveryEnd: parsed.dueDate,
      terms: parsed.terms,
      totalUnits: parsed.totalUnits,
      totalPrice: parsed.totalPrice,
      items: parsed.items.map((item) => ({
        productName: item.productName,
        styleNumber: item.styleNumber,
        msrp: 0,
        color: item.colorCode,
        colorCode: item.colorCode,
        unitPrice: item.unitPrice,
        totalUnits: item.quantity,
        totalPrice: item.extendedAmount,
        sizes: item.size
          ? [{ size: item.size, quantity: item.quantity }]
          : [{ size: "OS", quantity: item.quantity }],
      })),
    };

    return res.status(200).json(normalized);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logError("Z Supply preview error", error);
    return res.status(500).json({ error: msg || "Parse failed" });
  }
}
