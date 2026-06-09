// /app/src/pages/api/admin/staff/[id]/set-password.ts
//
// Set or reset a staff member's local sign-in password (the credentials auth
// method). Ensures the StaffMember has a linked NextAuth User row so the
// existing role-resolution path (StaffMember -> User.id) works on login.
// ADMIN / SUPER_ADMIN only.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth/password";
import { logError } from "@/lib/logger";

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const staffId = Number.parseInt(String(req.query.id), 10);
  if (!Number.isInteger(staffId)) {
    return res.status(400).json({ error: "Invalid staff id" });
  }

  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  try {
    const staff = await prisma.staffMember.findUnique({
      where: { id: staffId },
      select: { id: true, email: true, displayName: true, userId: true },
    });
    if (!staff) {
      return res.status(404).json({ error: "Staff member not found" });
    }
    if (!staff.email) {
      return res
        .status(400)
        .json({ error: "Staff member needs an email address before a password can be set." });
    }

    const passwordHash = hashPassword(password);

    // A local account needs a linked User row (the role system resolves
    // StaffMember by User.id, and credentials authorize returns that id).
    // Reuse an existing User with the same email if present, else create one.
    let userId = staff.userId;
    if (!userId) {
      const existingUser = await prisma.user.findUnique({
        where: { email: staff.email },
        select: { id: true },
      });
      userId =
        existingUser?.id ??
        (
          await prisma.user.create({
            data: { email: staff.email, name: staff.displayName },
            select: { id: true },
          })
        ).id;
    }

    await prisma.staffMember.update({
      where: { id: staff.id },
      data: { passwordHash, userId },
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    logError("Failed to set staff password", err);
    return res.status(500).json({ error: "Failed to set password" });
  }
});
