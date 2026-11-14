// /app/src/pages/api/categories/index.ts

import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { readTaxGroupId } from "@/lib/tax/taxGroupInput";
import type { Session } from "next-auth";
import type { CallerAccess } from "@/lib/auth/gateOptions";
import { auditActor, auditLog } from "@/lib/audit";
import { markupProblem, markupValue } from "@/lib/pricing/markup";

/** A category's markup prices its products: setting one needs "Change pricing" (GAP-06). */
const PRICING = "catalog.pricing";

async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: CallerAccess,
) {
  try {
    if (req.method === "GET") {
      const fetchAll = req.query.all === "true";

      const page = Number.parseInt(req.query.page as string) || 1;
      const limit = Number.parseInt(req.query.limit as string) || 10;
      const search = (req.query.search as string)?.trim() || "";

      const skip = (page - 1) * limit;

      const where: any = search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" as const } },
              { department: { name: { contains: search, mode: "insensitive" as const } } },
            ],
          }
        : {};

      const findManyArgs: Prisma.CategoryFindManyArgs = {
        where,
        orderBy: { name: Prisma.SortOrder.asc },
        include: {
          department: true,
          labelTemplate: true,
          accountGroup: { select: { id: true, name: true } },
        },
      };

      if (!fetchAll) {
        findManyArgs.skip = skip;
        findManyArgs.take = limit;
      }

      const [categories, total] = await Promise.all([
        prisma.category.findMany(findManyArgs),
        prisma.category.count({ where }),
      ]);

      // This section uses type assertions to help TypeScript compile
      // when it's being overly strict about relations after an include.
      const mappedCategories = categories.map((cat) => ({
        ...cat,
        departmentName: (cat as any).department?.name,
        labelTemplateName: (cat as any).labelTemplate?.name,
      }));

      return res.status(200).json({ categories: mappedCategories, total });
    }

    if (req.method === "POST") return await handlePost(req, res, session, access);

    res.setHeader("Allow", ["GET", "POST"]);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  } catch (err) {
    logError("API error", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

/** A new category, with its markup when one is given (needs "Change pricing", audited). */
async function handlePost(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: CallerAccess,
) {
  const { name, departmentId, trackInventory, accountGroupId, labelTemplateId } = req.body;
  const taxGroup = await readTaxGroupId(prisma, req.body.taxGroupId);
  if ("error" in taxGroup) return res.status(400).json({ error: taxGroup.error });

  // Its markup (GAP-06): a multiplier, or none to follow the vendor's or the store's.
  const markup: unknown = req.body.defaultMarkup === "" ? null : (req.body.defaultMarkup ?? null);
  const problem = markupProblem(markup);
  if (problem) return res.status(400).json({ error: problem });
  const multiplier = markupValue(markup);
  if (multiplier !== null && !access.holds[PRICING]) {
    return res
      .status(403)
      .json({ error: "Giving a category a markup needs the Change pricing permission." });
  }

  const created = await prisma.$transaction(async (tx) => {
    const category = await tx.category.create({
      data: {
        name,
        departmentId,
        trackInventory,
        accountGroupId: accountGroupId ? Number.parseInt(accountGroupId) : null,
        labelTemplateId: labelTemplateId || null,
        taxGroupId: taxGroup.value ?? null,
        defaultMarkup: multiplier,
      },
    });
    if (multiplier !== null) {
      await auditLog(
        "MARKUP_CHANGED",
        auditActor(session),
        {
          summary: `${category.name}: category markup none → ${multiplier}`,
          details: { scope: "category", categoryId: category.id, from: null, to: multiplier },
        },
        tx,
      );
    }
    return category;
  });

  return res.status(201).json(created);
}

export default requirePermission("catalog.write", handler, { also: [PRICING] });
