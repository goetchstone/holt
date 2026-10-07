// /app/src/pages/api/admin/reports/commission-tiers/tiers.ts
//
// SUPER_ADMIN-only CRUD for commission PLANS (named tier sets). Kept at the
// legacy tiers path so the commission-tiers page's fetch prefix is unchanged.
// All validation + persistence lives in @/lib/commissionPlans — this handler
// only maps HTTP verbs onto those helpers.
//
//   GET    -> { plans }                      list plans (tiers + assignedCount)
//   POST   { name, description?, tiers? }    create plan (empty tiers seed from fallback)
//   PUT    { planId, tiers }                 replace a plan's tier set
//   PATCH  { planId, action: "setDefault" }  make a plan the default
//   PATCH  { planId, name?, description?, isActive? }  rename / describe / (de)activate
//   DELETE { planId }                        delete (refuses when default or assigned)

import type { NextApiRequest, NextApiResponse } from "next";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { getErrorCode } from "@/lib/errorCode";
import {
  createPlan,
  deletePlan,
  listPlans,
  replacePlanTiers,
  setDefaultPlan,
  PlanValidationError,
  type TierInput,
} from "@/lib/commissionPlans";

interface PostBody {
  name: string;
  description?: string | null;
  tiers?: TierInput[];
}

interface PutBody {
  planId: number;
  tiers: TierInput[];
}

interface PatchBody {
  planId: number;
  action?: "setDefault";
  name?: string;
  description?: string | null;
  isActive?: boolean;
}

interface DeleteBody {
  planId: number;
}

function parsePlanId(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function sessionEmail(session: Session): string | null {
  return session.user?.email ?? null;
}

async function handlePost(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const body = (req.body ?? {}) as Partial<PostBody>;
  if (typeof body.name !== "string" || !body.name.trim()) {
    return res.status(400).json({ error: "Plan name is required" });
  }
  const created = await createPlan({
    name: body.name,
    description: typeof body.description === "string" ? body.description : null,
    tiers: Array.isArray(body.tiers) ? body.tiers : undefined,
    createdBy: sessionEmail(session),
  });
  return res.status(201).json({ id: created.id });
}

async function handlePut(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const body = (req.body ?? {}) as Partial<PutBody>;
  const planId = parsePlanId(body.planId);
  if (planId === null) return res.status(400).json({ error: "planId is required" });
  if (!Array.isArray(body.tiers) || body.tiers.length === 0) {
    return res.status(400).json({ error: "Body must include non-empty `tiers` array" });
  }
  await replacePlanTiers(planId, body.tiers, sessionEmail(session));
  return res.status(200).json({ plans: await listPlans() });
}

async function handlePatch(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const body = (req.body ?? {}) as Partial<PatchBody>;
  const planId = parsePlanId(body.planId);
  if (planId === null) return res.status(400).json({ error: "planId is required" });

  if (body.action === "setDefault") {
    await setDefaultPlan(planId);
    return res.status(200).json({ plans: await listPlans() });
  }

  const data: Prisma.CommissionPlanUpdateInput = { updatedBy: sessionEmail(session) };
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return res.status(400).json({ error: "Plan name must be non-empty" });
    }
    data.name = body.name.trim();
  }
  if (body.description !== undefined) {
    data.description = typeof body.description === "string" ? body.description : null;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") {
      return res.status(400).json({ error: "isActive must be a boolean" });
    }
    data.isActive = body.isActive;
  }

  const existing = await prisma.commissionPlan.findUnique({ where: { id: planId } });
  if (!existing) return res.status(400).json({ error: "Plan not found" });

  await prisma.commissionPlan.update({ where: { id: planId }, data });
  return res.status(200).json({ plans: await listPlans() });
}

async function handleDelete(req: NextApiRequest, res: NextApiResponse) {
  const body = (req.body ?? {}) as Partial<DeleteBody>;
  const planId = parsePlanId(body.planId);
  if (planId === null) return res.status(400).json({ error: "planId is required" });
  await deletePlan(planId);
  return res.status(200).json({ plans: await listPlans() });
}

export default requireAuthWithRole(
  ["SUPER_ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session: Session) => {
    try {
      switch (req.method) {
        case "GET":
          return res.status(200).json({ plans: await listPlans() });
        case "POST":
          return await handlePost(req, res, session);
        case "PUT":
          return await handlePut(req, res, session);
        case "PATCH":
          return await handlePatch(req, res, session);
        case "DELETE":
          return await handleDelete(req, res);
        default:
          res.setHeader("Allow", ["GET", "POST", "PUT", "PATCH", "DELETE"]);
          return res.status(405).json({ error: "Method not allowed" });
      }
    } catch (err: unknown) {
      if (err instanceof PlanValidationError) {
        return res.status(400).json({ error: err.message });
      }
      if (getErrorCode(err) === "P2002") {
        return res.status(400).json({ error: "A plan with that name already exists" });
      }
      logError("commission-plans request failed", err, { method: req.method });
      return res.status(500).json({ error: "Commission plan operation failed" });
    }
  },
);
