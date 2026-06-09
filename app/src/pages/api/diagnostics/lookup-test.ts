// /app/src/pages/api/diagnostics/lookup-test.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { getErrorMessage } from "@/lib/toastError";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { identifier } = req.body;

  if (!identifier || typeof identifier !== "string") {
    return res.status(400).json({ error: "Identifier is required." });
  }

  const sanitizedIdentifier = identifier.trim();
  const results: any = {
    searchTerm: sanitizedIdentifier,
    searchType: "Unknown",
    found: false,
    product: null,
    error: null,
  };

  try {
    // Attempt 1: Case-insensitive search on the UPC table
    results.searchType = "UPC (Case-Insensitive)";
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
      results.found = true;
      results.product = upc.product;
      return res.status(200).json(results);
    }

    // Attempt 2: Case-insensitive search on the Product Number
    results.searchType = "Product Number (Case-Insensitive)";
    const product = await prisma.product.findFirst({
      where: {
        productNumber: {
          equals: sanitizedIdentifier,
          mode: "insensitive",
        },
      },
    });

    if (product) {
      results.found = true;
      results.product = product;
      return res.status(200).json(results);
    }

    // If we reach here, nothing was found
    results.error = "No match found for the given identifier in UPCs or Product Numbers.";
    return res.status(404).json(results);
  } catch (error: unknown) {
    results.error = `An unexpected database error occurred: ${getErrorMessage(error, "unknown error")}`;
    return res.status(500).json(results);
  }
}
