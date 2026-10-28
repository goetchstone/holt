// /app/src/pages/api/staff/active-store.ts
//
// GET: returns the current user's active store location
// PUT: sets the current user's active store location
//
// Both also answer `taxDistrictConfigured`: does a sale at that store resolve a
// tax district (its own, or the deployment default)? false means
// resolveTaxRate.ts charges 0% there, and the POS and New Quote screens -- the
// two that ring sales against the active store -- say so in an amber banner.
// The sale itself is never blocked. Riding on this response rather than a new
// route keeps it on the same self-service key those screens already use.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/appSettings";
import { taxDistrictConfigured } from "@/lib/gettingStarted";
import { badRequest, notFound, methodNotAllowed, success } from "@/lib/apiResponse";

const STORE_SELECT = { id: true, name: true, code: true, type: true, taxDistrictId: true } as const;

/** The store as the screens see it, plus whether a sale there resolves a tax district. */
async function describeStore(
  store: {
    id: number;
    name: string;
    code: string;
    type: string;
    taxDistrictId: number | null;
  } | null,
) {
  const { defaultTaxDistrictId } = await getAppSettings();
  if (!store) {
    return {
      activeStoreLocation: null,
      taxDistrictConfigured: taxDistrictConfigured(undefined, defaultTaxDistrictId),
    };
  }
  const { taxDistrictId, ...activeStoreLocation } = store;
  return {
    activeStoreLocation,
    taxDistrictConfigured: taxDistrictConfigured(taxDistrictId, defaultTaxDistrictId),
  };
}

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const email = session.user?.email;
  if (!email) return badRequest(res, "No email in session");

  const staff = await prisma.staffMember.findFirst({
    where: { email },
    include: { activeStoreLocation: { select: STORE_SELECT } },
  });

  if (!staff) return notFound(res, "Staff member");

  if (req.method === "GET") {
    return success(res, {
      ...(await describeStore(staff.activeStoreLocation)),
      staffId: staff.id,
      displayName: staff.displayName,
    });
  }

  if (req.method === "PUT") {
    const { storeLocationId } = req.body;
    if (!storeLocationId) return badRequest(res, "storeLocationId is required");

    const store = await prisma.storeLocation.findUnique({
      where: { id: Number.parseInt(storeLocationId) },
      select: STORE_SELECT,
    });

    if (!store) return notFound(res, "Store location");

    await prisma.staffMember.update({
      where: { id: staff.id },
      data: { activeStoreLocationId: store.id },
    });

    return success(res, await describeStore(store));
  }

  return methodNotAllowed(res, ["GET", "PUT"]);
}

// Self-service: every staff role sets their own active store location.
export default requirePermission("staff.self", handler);
