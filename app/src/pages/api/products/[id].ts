// /app/src/pages/api/products/[id].ts

import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import type { CallerAccess } from "@/lib/auth/gateOptions";
import { auditActor } from "@/lib/audit";
import { readTaxGroupId } from "@/lib/tax/taxGroupInput";
import { logError } from "@/lib/logger";
import {
  applyRetailChanges,
  priceProblem,
  sameMoney,
  setPriceLocks,
  type RetailChange,
} from "@/lib/pricing/retailWriter";

/** Changing a product's retail or its price lock needs "Change pricing"; its was price doesn't (DECISIONS 43, 58). */
const PRICING = "catalog.pricing";

/** How many of a product's price changes its screen lists, newest first. */
const PRICE_HISTORY_SHOWN = 50;

// Enough for what a law tag lists, and more than fits on one.
const LAW_TAG_TEXT_MAX = 1000;

async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: CallerAccess,
) {
  const { id } = req.query;
  const productId = Number.parseInt(id as string);
  if (Number.isNaN(productId)) return res.status(400).json({ error: "Invalid product ID" });

  if (req.method === "GET") {
    try {
      const product = await prisma.product.findUnique({
        where: { id: productId },
        include: {
          vendor: { select: { id: true, name: true } },
          department: { select: { id: true, name: true } },
          category: {
            select: { id: true, name: true, taxGroup: { select: { id: true, name: true } } },
          },
          taxGroup: { select: { id: true, name: true } },
          type: { select: { id: true, name: true } },
          collection: { select: { id: true, name: true } },
          upcs: { orderBy: { sortOrder: "asc" } },
          vendorStyle: { select: { id: true, styleNumber: true, name: true } },
          priceChanges: {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: PRICE_HISTORY_SHOWN,
          },
        },
      });

      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }

      return res.status(200).json({
        id: product.id,
        externalId: product.externalId,
        productNumber: product.productNumber,
        name: product.name,
        description: product.description,
        season: product.season,
        imageUrl: product.imageUrl,
        isActive: product.isActive,
        isDiscontinued: product.isDiscontinued,
        baseCost: product.baseCost != null ? Number(product.baseCost) : null,
        // The average landed cost of its receipts (GAP-02); null until one.
        landedCost: product.landedCost != null ? Number(product.landedCost) : null,
        baseRetail: product.baseRetail != null ? Number(product.baseRetail) : null,
        mapPrice: product.mapPrice != null ? Number(product.mapPrice) : null,
        wasPrice: product.wasPrice != null ? Number(product.wasPrice) : null,
        // Kept by imports, mass changes and style edits (GAP-06).
        priceLocked: product.priceLocked,
        // Its price ledger, newest first (lib/pricing/retailWriter.ts).
        priceHistory: product.priceChanges.map((c) => ({
          id: c.id,
          fromRetail: c.fromRetail != null ? Number(c.fromRetail) : null,
          toRetail: c.toRetail != null ? Number(c.toRetail) : null,
          fromWas: c.fromWas != null ? Number(c.fromWas) : null,
          toWas: c.toWas != null ? Number(c.toWas) : null,
          source: c.source,
          batchId: c.batchId,
          note: c.note,
          actor: c.actor,
          createdAt: c.createdAt,
        })),
        lawTagText: product.lawTagText,
        length: product.length,
        width: product.width,
        depth: product.depth,
        height: product.height,
        weight: product.weight,
        cubicFeet: product.cubicFeet,
        seatHeight: product.seatHeight,
        armHeight: product.armHeight,
        seatDepth: product.seatDepth,
        freightClass: product.freightClass,
        shipsVia: product.shipsVia,
        cartonQty: product.cartonQty,
        boxesPerUnit: product.boxesPerUnit,
        // Its own tax group, or null to sell under its category's.
        taxGroupId: product.taxGroupId,
        taxGroup: product.taxGroup,
        vendor: product.vendor,
        department: product.department,
        category: product.category,
        type: product.type,
        collection: product.collection,
        vendorStyle: product.vendorStyle,
        upcs: product.upcs.map((u) => ({ id: u.id, upc: u.upc })),
        created: product.created,
        serviceType: product.serviceType,
        updated: product.updated,
      });
    } catch (error) {
      logError("Error fetching product", error);
      return res.status(500).json({ error: "Failed to fetch product" });
    }
  } else if (req.method === "PATCH") {
    // The body must be a JSON object. `length` below is the product's length
    // field, but on an array or string body it is the body's own length: a
    // PATCH of `[1,2,3]` set the product's length to 3 (CodeQL
    // js/type-confusion-through-parameter-tampering #18).
    const body: unknown = req.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return res.status(400).json({ error: "Request body must be a JSON object" });
    }
    try {
      const {
        name,
        productNumber,
        description,
        season,
        baseRetail,
        length,
        depth,
        height,
        boxesPerUnit,
        serviceType,
        isDiscontinued,
        wasPrice,
        lawTagText,
        priceLocked,
      } = body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- same untyped shape req.body had

      const validServiceTypes = ["MEASURE", "INSTALL", "DELIVERY", "HOUSE_CALL"];
      const resolvedServiceType =
        serviceType && validServiceTypes.includes(serviceType) ? serviceType : null;

      const parseOptionalFloat = (val: unknown): number | null | undefined => {
        if (val === undefined) return undefined;
        if (val === null || val === "") return null;
        const num = Number.parseFloat(String(val));
        return Number.isNaN(num) ? null : num;
      };

      // How many boxes one unit ships in: a whole number from 1 to 99, or
      // cleared (one box). Box labels and box scans count against it.
      let boxes: number | null | undefined;
      if (boxesPerUnit === undefined) boxes = undefined;
      else if (boxesPerUnit === null || boxesPerUnit === "") boxes = null;
      else {
        const n = Number(boxesPerUnit);
        if (!Number.isInteger(n) || n < 1 || n > 99) {
          return res
            .status(400)
            .json({ error: "Boxes per unit must be a whole number from 1 to 99." });
        }
        boxes = n;
      }

      // Discontinued (GAP-16): no longer ordered -- the PO pickers leave it out
      // (purchasing/vendor-products.ts) -- and what is on hand still sells.
      // Staff set it here; it was set only by the POS import.
      if (isDiscontinued !== undefined && typeof isDiscontinued !== "boolean") {
        return res.status(400).json({ error: "isDiscontinued must be true or false." });
      }

      // For a sale tag (lib/labels/productTag.ts). Absent leaves each alone.
      const was = parseOptionalFloat(wasPrice);
      if (was != null && !(was > 0)) {
        return res.status(400).json({ error: "The was price must be above zero." });
      }
      if (wasPrice !== undefined && wasPrice !== null && wasPrice !== "" && was == null) {
        return res.status(400).json({ error: "The was price must be a number." });
      }
      const wasProblem = was == null ? null : priceProblem(was, "was");
      if (wasProblem) return res.status(400).json({ error: wasProblem });
      // Retail: absent leaves it, empty clears it, anything else must be a price.
      const retail = parseOptionalFloat(baseRetail);
      if (baseRetail !== undefined && baseRetail !== null && baseRetail !== "" && retail == null) {
        return res.status(400).json({ error: "The retail price must be a number." });
      }
      if (priceLocked !== undefined && typeof priceLocked !== "boolean") {
        return res.status(400).json({ error: "priceLocked must be true or false." });
      }
      if (lawTagText !== undefined && lawTagText !== null && typeof lawTagText !== "string") {
        return res.status(400).json({ error: "The law tag wording must be text." });
      }
      if (typeof lawTagText === "string" && lawTagText.length > LAW_TAG_TEXT_MAX) {
        return res
          .status(400)
          .json({ error: `Keep the law tag wording under ${LAW_TAG_TEXT_MAX} characters.` });
      }

      const taxGroup = await readTaxGroupId(prisma, (body as Record<string, unknown>).taxGroupId);
      if ("error" in taxGroup) return res.status(400).json({ error: taxGroup.error });

      const before = await prisma.product.findUnique({
        where: { id: productId },
        select: { baseRetail: true, wasPrice: true, priceLocked: true },
      });
      if (!before) return res.status(404).json({ error: "Product not found" });

      // The edit form sends every field back, so the gate is on a CHANGE: an
      // unchanged retail or lock is no pricing decision.
      const retailMoves = retail !== undefined && !sameMoney(before.baseRetail, retail);
      const lockMoves = priceLocked !== undefined && priceLocked !== before.priceLocked;
      // Checked only when it moves: a price an import stored past the cent is
      // resent unchanged by the edit form and must not block the save.
      const retailProblem = retailMoves && retail !== null ? priceProblem(retail!, "retail") : null;
      if (retailProblem) return res.status(400).json({ error: retailProblem });
      if ((retailMoves || lockMoves) && !access.holds[PRICING]) {
        return res.status(403).json({
          error: lockMoves
            ? "Locking or unlocking a price needs the Change pricing permission."
            : "Changing a retail price needs the Change pricing permission.",
        });
      }

      const actor = auditActor(session);
      const updatedProduct = await prisma.$transaction(async (tx) => {
        await tx.product.update({
          where: { id: productId },
          data: {
            name: name || undefined,
            productNumber: productNumber || undefined,
            description: description === "" ? null : description,
            season: season === "" ? null : season,
            lawTagText: lawTagText === undefined ? undefined : lawTagText?.trim() || null,
            length: parseOptionalFloat(length),
            depth: parseOptionalFloat(depth),
            height: parseOptionalFloat(height),
            boxesPerUnit: boxes,
            taxGroupId: taxGroup.value,
            // Only when sent: a PATCH that leaves it out (a discontinued toggle)
            // used to clear it.
            serviceType: serviceType === undefined ? undefined : resolvedServiceType,
            isDiscontinued,
            updatedBy: actor,
          },
        });
        // Its price, through the one writer: a person editing this product
        // changes it even when it is locked -- the lock stops automatic writers.
        const change: RetailChange = { productId };
        if (retailMoves) change.toRetail = retail;
        if (was !== undefined) change.toWas = was;
        if (change.toRetail !== undefined || change.toWas !== undefined) {
          await applyRetailChanges(tx, [change], {
            source: "MANUAL",
            actor,
            honourLock: false,
            audit: "each",
          });
        }
        if (priceLocked !== undefined) {
          await setPriceLocks(tx, [productId], priceLocked, { actor, audit: "each" });
        }
        return tx.product.findUniqueOrThrow({ where: { id: productId } });
      });

      return res.status(200).json(updatedProduct);
    } catch (err) {
      logError("Error updating product", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  } else {
    return res.status(405).end();
  }
}

export default requirePermission("catalog.write", handler, { also: [PRICING] });
