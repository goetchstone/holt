// /app/src/lib/automations/guardAutomation.ts
//
// One gate for every automation TRIGGER route (the ones a nightly scheduler
// hits and an operator can fire by hand).
//
// These used to accept "any authenticated session" -- `if (session?.user?.email)
// return true` -- so any staff account, and after SEC-01 any account at all,
// could fire daily reconciliation, AR-drift checks, stale-payment expiry, the
// Mailchimp and traffic syncs, and lead housekeeping. Running the business's
// scheduled jobs is a system-administration action, not a side effect of being
// logged in.
//
// Two ways in now, and only two:
//   - the scheduler presents AUTO_IMPORT_API_KEY as a Bearer token (unchanged);
//   - a human session must hold `admin.automations` (held by ADMIN/Owner, and
//     grantable to any custom role from Admin > Setup > Roles).
//
// requirePermission does the real work -- session, role, DB permission
// resolution, the bootstrap safeguard, and the 401/403 -- so this wrapper only
// adds the service-key bypass in front of it. The wrapped body still receives
// the resolved session (null on the key path) so routes that stamp `createdBy`
// keep working.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";

/** The scheduler's service-key path. Absent key or wrong token -> not the scheduler. */
export function authorizedByAutoImportKey(req: NextApiRequest): boolean {
  const key = process.env.AUTO_IMPORT_API_KEY;
  return !!key && req.headers.authorization === `Bearer ${key}`;
}

export type AutomationHandler = (
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session | null,
) => Promise<void | NextApiResponse>;

/**
 * Wrap an automation trigger. The service key bypasses to the handler with a
 * null session; otherwise `admin.automations` is required and the handler runs
 * with the authenticated session.
 */
export function guardAutomation(run: AutomationHandler) {
  return (req: NextApiRequest, res: NextApiResponse) => {
    if (authorizedByAutoImportKey(req)) return run(req, res, null);
    return requirePermission("admin.automations", (rq, rs, session) => run(rq, rs, session))(
      req,
      res,
    );
  };
}
