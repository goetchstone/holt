// /app/src/pages/api/admin/staff/[id]/set-password.ts
//
// Set or reset a staff member's local sign-in password (the credentials auth
// method). Ensures the StaffMember has a linked NextAuth User row so the
// existing role-resolution path (StaffMember -> User.id) works on login.
//
// Who may: setting someone's password lets the setter sign in as them, so it is
// a sign-in change (signInChangeRefusal in lib/auth/roleAssignment): admins
// only, and a member in the owner tier only by an owner. The route's gate is
// staff.manage, which also admits General Managers and People Operations; the
// rule runs inside it, in one transaction with the member's row locked, on the
// member's CURRENT tier read strictly (either role column saying Owner, or an
// owner-only key their Role holds).

import type { NextApiRequest, NextApiResponse } from "next";
import type { Prisma } from "@prisma/client";
import { requirePermission } from "@/lib/auth/requireAuth";
import { auditActor, auditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth/password";
import { logError } from "@/lib/logger";
import { signInChangeRefusal } from "@/lib/auth/roleAssignment";
import { isWriteConflict } from "@/lib/errorCode";

type Tx = Prisma.TransactionClient;

/** Thrown to unwind the transaction with an HTTP answer attached. */
class RefusedError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RefusedError";
  }
}

/**
 * The login an unlinked member's password goes with: the User holding their
 * email, else a new one. A local account needs a linked User row (the role
 * system resolves StaffMember by User.id, and credentials authorize returns
 * that id). A User that is already another member's login is refused with a
 * 409: linking it would hand this member's password to that login (and the
 * unique index on StaffMember.userId would refuse it as a 500).
 */
async function loginFor(tx: Tx, staffId: number, email: string, name: string): Promise<string> {
  const existing = await tx.user.findUnique({ where: { email }, select: { id: true } });
  if (!existing) {
    return (await tx.user.create({ data: { email, name }, select: { id: true } })).id;
  }
  const holder = await tx.staffMember.findFirst({
    where: { userId: existing.id, id: { not: staffId } },
    select: { isActive: true },
  });
  if (holder) {
    throw new RefusedError(
      409,
      holder.isActive
        ? "That email's login already belongs to another active staff member."
        : "That email's login already belongs to another (inactive) staff member.",
    );
  }
  return existing.id;
}

export default requirePermission(
  "staff.manage",
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const staffId = Number.parseInt(String(req.query.id), 10);
    if (!Number.isInteger(staffId)) {
      return res.status(400).json({ error: "Invalid staff id" });
    }

    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (password.length < 12) {
      return res.status(400).json({ error: "Password must be at least 12 characters." });
    }

    try {
      const passwordHash = hashPassword(password);
      await prisma.$transaction(async (tx) => {
        // The member's row is locked, so the rule judges the row the write lands on.
        await tx.$queryRaw`SELECT id FROM "StaffMember" WHERE id = ${staffId} FOR UPDATE`;
        const refusal = await signInChangeRefusal(tx, session, staffId, "password");
        if (refusal) throw new RefusedError(refusal.status, refusal.error);
        const member = await tx.staffMember.findUniqueOrThrow({
          where: { id: staffId },
          select: { id: true, email: true, displayName: true, userId: true },
        });
        if (!member.email) {
          throw new RefusedError(
            400,
            "Staff member needs an email address before a password can be set.",
          );
        }
        const userId =
          member.userId ?? (await loginFor(tx, member.id, member.email, member.displayName));
        await tx.staffMember.update({
          where: { id: member.id },
          data: { passwordHash, userId },
        });
        await auditLog(
          "PASSWORD_SET",
          auditActor(session),
          {
            summary: `Password set for ${member.displayName}`,
            target: { type: "staff", id: member.id },
          },
          tx,
        );
      });
      return res.status(200).json({ ok: true });
    } catch (err) {
      if (err instanceof RefusedError) return res.status(err.status).json({ error: err.message });
      if (isWriteConflict(err)) {
        return res
          .status(409)
          .json({ error: "Someone else changed this staff member; try again." });
      }
      logError("Failed to set staff password", err);
      return res.status(500).json({ error: "Failed to set password" });
    }
  },
);
