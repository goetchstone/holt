// /app/src/pages/api/cms/menus/[location].ts
//
// CMS navigation menu for a location ("header" | "footer"). GET reads items,
// PUT replaces them. ADMIN-gated.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import { parseMenuInput } from "@/lib/cms/requestBody";
import { parseMenuItems, MENU_LOCATIONS, type MenuLocation } from "@/lib/cms/menu";
import { getErrorMessage } from "@/lib/toastError";
import { logError } from "@/lib/logger";

function isMenuLocation(value: unknown): value is MenuLocation {
  return typeof value === "string" && (MENU_LOCATIONS as readonly string[]).includes(value);
}

export default requireAuthWithRole(
  ["ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    const location = req.query.location;
    if (!isMenuLocation(location)) {
      return res.status(400).json({ error: "Unknown menu location" });
    }

    if (req.method === "GET") {
      const menu = await prisma.menu.findUnique({
        where: { organizationId_location: { organizationId: DEFAULT_ORG_ID, location } },
      });
      return res.json({ items: parseMenuItems(menu?.items ?? null) });
    }

    if (req.method === "PUT") {
      try {
        const items = parseMenuInput(req.body);
        const email = session.user?.email ?? null;
        const menu = await prisma.menu.upsert({
          where: { organizationId_location: { organizationId: DEFAULT_ORG_ID, location } },
          update: { items, updatedBy: email },
          create: {
            organizationId: DEFAULT_ORG_ID,
            location,
            items,
            createdBy: email,
            updatedBy: email,
          },
        });
        return res.json({ items: parseMenuItems(menu.items) });
      } catch (err: unknown) {
        logError("CMS menu save failed", err);
        return res.status(400).json({ error: getErrorMessage(err, "Could not save menu") });
      }
    }

    res.setHeader("Allow", ["GET", "PUT"]);
    return res.status(405).json({ error: "Method not allowed" });
  },
);
