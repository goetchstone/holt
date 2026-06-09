// /app/src/pages/api/products/find-by-identifier.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  // CORRECTED: This API now accepts both GET and POST requests to be more resilient.
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  // Determine the identifier based on the request method
  let identifier: string | undefined;
  if (req.method === "GET") {
    identifier = req.query.identifier as string;
  } else {
    // POST
    identifier = req.body.identifier as string;
  }

  if (!identifier || typeof identifier !== "string") {
    return res.status(400).json({ error: "Identifier is required" });
  }

  const sanitizedIdentifier = identifier.trim();

  if (!sanitizedIdentifier) {
    return res.status(400).json({ error: "Identifier is required" });
  }

  try {
    // The robust, sequential search logic remains the same.
    // Step 1: Search UPCs first.
    const upc = await prisma.upc.findFirst({
      where: {
        upc: {
          equals: sanitizedIdentifier,
          mode: "insensitive",
        },
      },
      include: { product: true },
    });

    if (upc && upc.product) {
      return res.status(200).json(upc.product);
    }

    // Step 2: If no UPC, search Product Numbers.
    const product = await prisma.product.findFirst({
      where: {
        productNumber: {
          equals: sanitizedIdentifier,
          mode: "insensitive",
        },
      },
    });

    if (product) {
      return res.status(200).json(product);
    }

    return res
      .status(404)
      .json({ error: `Product not found for identifier: "${sanitizedIdentifier}"` });
  } catch (error) {
    logError("Find product by identifier error", error);
    res.status(500).json({ error: "An internal server error occurred." });
  }
}
