// /app/src/pages/api/service/cases/[id]/notes.ts

import { getErrorCode } from "@/lib/errorCode";
import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { created, badRequest, notFound, methodNotAllowed, handleError } from "@/lib/apiResponse";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const caseId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(caseId)) return badRequest(res, "Invalid case ID");

  const { note, isInternal } = req.body;
  if (!note?.trim()) return badRequest(res, "Note text is required");

  try {
    const staff = await prisma.staffMember.findFirst({
      where: { email: session.user?.email },
    });

    const caseNote = await prisma.serviceCaseNote.create({
      data: {
        caseId,
        authorId: staff?.id || null,
        note: note.trim(),
        isInternal: isInternal ?? true,
        createdBy: session.user?.email || null,
      },
      include: {
        author: { select: { id: true, displayName: true } },
      },
    });

    return created(res, caseNote);
  } catch (err: unknown) {
    if (getErrorCode(err) === "P2003") return notFound(res, "Case");
    return handleError(res, err, "POST /service/cases/[id]/notes");
  }
}

// Case notes are written by the service team. Register/Marketing have no
// reason to add notes to a service case.
export default requirePermission("service.write", handler);
