// /app/src/pages/api/pricing/options.ts
//
// CRUD API for vendor-level option groups and options.
// GET  ?vendorId=X        → list all groups + options for vendor
// POST                    → create group or option
// PATCH                   → update group or option
// DELETE                  → delete option or group (cascades overrides)

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "../auth/[...nextauth]";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  // ─── GET: list groups + options ──────────────────────────────────
  if (req.method === "GET") {
    const vendorId = Number.parseInt(req.query.vendorId as string);
    if (!vendorId) return res.status(400).json({ error: "Missing vendorId" });

    const rawGroups = await prisma.vendorOptionGroup.findMany({
      where: { vendorId },
      include: {
        options: { orderBy: { sortOrder: "asc" } },
      },
      orderBy: { name: "asc" },
    });

    // Convert Prisma Decimal objects to plain numbers for JSON serialization
    const groups = rawGroups.map((g) => ({
      ...g,
      options: g.options.map((o) => ({
        ...o,
        defaultSurcharge: Number(o.defaultSurcharge),
        sortOrder: Number(o.sortOrder),
      })),
    }));

    return res.status(200).json({ groups });
  }

  // ─── POST: create group or option ───────────────────────────────
  if (req.method === "POST") {
    const {
      action,
      vendorId,
      groupId,
      name,
      description,
      surchargeType,
      defaultSurcharge,
      sortOrder,
    } = req.body;

    if (action === "createGroup") {
      if (!vendorId || !name) return res.status(400).json({ error: "Missing vendorId or name" });

      const group = await prisma.vendorOptionGroup.create({
        data: {
          vendorId,
          name,
          description: description || null,
        },
      });
      return res.status(201).json(group);
    }

    if (action === "createOption") {
      if (!groupId || !name) return res.status(400).json({ error: "Missing groupId or name" });

      const option = await prisma.vendorOption.create({
        data: {
          groupId,
          name,
          surchargeType: surchargeType || "FLAT",
          defaultSurcharge: defaultSurcharge ?? 0,
          sortOrder: sortOrder ?? 0,
        },
      });
      return res.status(201).json(option);
    }

    return res.status(400).json({ error: "Invalid action. Use createGroup or createOption." });
  }

  // ─── PATCH: update group or option ──────────────────────────────
  if (req.method === "PATCH") {
    const { action, id, name, description, surchargeType, defaultSurcharge, sortOrder } = req.body;

    if (action === "updateGroup") {
      if (!id) return res.status(400).json({ error: "Missing id" });
      const updated = await prisma.vendorOptionGroup.update({
        where: { id },
        data: {
          ...(name !== undefined && { name }),
          ...(description !== undefined && { description }),
        },
      });
      return res.status(200).json(updated);
    }

    if (action === "updateOption") {
      if (!id) return res.status(400).json({ error: "Missing id" });
      const updated = await prisma.vendorOption.update({
        where: { id },
        data: {
          ...(name !== undefined && { name }),
          ...(surchargeType !== undefined && { surchargeType }),
          ...(defaultSurcharge !== undefined && { defaultSurcharge }),
          ...(sortOrder !== undefined && { sortOrder }),
        },
      });
      return res.status(200).json(updated);
    }

    return res.status(400).json({ error: "Invalid action. Use updateGroup or updateOption." });
  }

  // ─── DELETE: remove option or group ─────────────────────────────
  if (req.method === "DELETE") {
    const { action, id } = req.body;

    if (action === "deleteOption") {
      if (!id) return res.status(400).json({ error: "Missing id" });

      // Delete overrides first, then the option
      await prisma.$transaction([
        prisma.productOptionOverride.deleteMany({ where: { optionId: id } }),
        prisma.vendorOption.delete({ where: { id } }),
      ]);
      return res.status(200).json({ success: true });
    }

    if (action === "deleteGroup") {
      if (!id) return res.status(400).json({ error: "Missing id" });

      // Get all option IDs in the group, delete their overrides, then options, then group
      const options = await prisma.vendorOption.findMany({
        where: { groupId: id },
        select: { id: true },
      });
      const optionIds = options.map((o) => o.id);

      await prisma.$transaction([
        prisma.productOptionOverride.deleteMany({ where: { optionId: { in: optionIds } } }),
        prisma.vendorOption.deleteMany({ where: { groupId: id } }),
        prisma.vendorOptionGroup.delete({ where: { id } }),
      ]);
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: "Invalid action. Use deleteOption or deleteGroup." });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
