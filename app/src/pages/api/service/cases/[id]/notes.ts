// /app/src/pages/api/service/cases/[id]/notes.ts

import { getErrorCode } from "@/lib/errorCode";
import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import {
  created,
  unauthorized,
  forbidden,
  badRequest,
  notFound,
  methodNotAllowed,
  handleError,
} from "@/lib/apiResponse";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return unauthorized(res);

  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  // Case notes are written by the service team. Register/Marketing have no
  // reason to add notes to a service case.
  const role = (session as unknown as { role?: string })?.role;
  if (
    !["SUPER_ADMIN", "DESIGNER", "MANAGER", "ADMIN", "WAREHOUSE", "INSTALLER"].includes(role ?? "")
  ) {
    return forbidden(res, "Insufficient role to add case note");
  }

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
